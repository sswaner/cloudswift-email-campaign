import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as events from 'aws-cdk-lib/aws-events';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EmailCampaignConfig } from '../config';

export interface SesFoundationProps {
  config: EmailCampaignConfig;
  eventBucket: s3.IBucket;
}

export class SesFoundation extends Construct {
  public readonly emailIdentity: ses.EmailIdentity;
  public readonly configurationSet: ses.ConfigurationSet;
  public readonly eventBus: events.IEventBus;
  public readonly deliveryStream: firehose.CfnDeliveryStream;

  constructor(scope: Construct, id: string, props: SesFoundationProps) {
    super(scope, id);
    const { config, eventBucket } = props;

    // Configuration set with reputation metrics, open/click tracking, auto validation, suppression
    this.configurationSet = new ses.ConfigurationSet(this, 'ConfigSet', {
      configurationSetName: config.configurationSetName,
      reputationMetrics: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
      customTrackingRedirectDomain: `${config.trackingSubdomain}.${config.domain}`,
      customTrackingHttpsPolicy: ses.HttpsPolicy.REQUIRE,
      autoValidationThreshold: ses.AutoValidationThreshold.HIGH,
    });

    // Domain identity with Easy DKIM 2048-bit and custom MAIL FROM
    this.emailIdentity = new ses.EmailIdentity(this, 'EmailIdentity', {
      identity: ses.Identity.domain(config.domain),
      dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
      mailFromDomain: `${config.mailFromSubdomain}.${config.domain}`,
      feedbackForwarding: false,
      configurationSet: this.configurationSet,
    });

    // SES event destination must use the default EventBridge bus
    this.eventBus = events.EventBus.fromEventBusName(this, 'SesEventBus', 'default');

    // Firehose delivery stream -> S3
    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    eventBucket.grantReadWrite(firehoseRole);

    this.deliveryStream = new firehose.CfnDeliveryStream(this, 'EventStream', {
      deliveryStreamName: `${config.tenantName}-email-events`,
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        roleArn: firehoseRole.roleArn,
        bucketArn: eventBucket.bucketArn,
        prefix: 'raw-events/domain=!{partitionKeyFromQuery:domain_id}/dt=!{timestamp:yyyy-MM-dd-HH}/',
        errorOutputPrefix: 'errors/result=!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd-HH}/',
        bufferingHints: {
          intervalInSeconds: 60,
          sizeInMBs: 5,
        },
        compressionFormat: 'GZIP',
        dynamicPartitioningConfiguration: {
          enabled: true,
        },
      },
    });

    const deliveryStreamRef = firehose.DeliveryStream.fromDeliveryStreamArn(
      this,
      'EventStreamRef',
      this.deliveryStream.attrArn,
    );

    // SES event destination: EventBridge
    new ses.ConfigurationSetEventDestination(this, 'EventBridgeDestination', {
      configurationSet: this.configurationSet,
      configurationSetEventDestinationName: 'eventbridge',
      events: [
        ses.EmailSendingEvent.SEND,
        ses.EmailSendingEvent.RENDERING_FAILURE,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.DELIVERY_DELAY,
        ses.EmailSendingEvent.OPEN,
        ses.EmailSendingEvent.CLICK,
        ses.EmailSendingEvent.SUBSCRIPTION,
      ],
      destination: ses.EventDestination.eventBus(this.eventBus),
    });

    // SES event destination: Firehose (raw event lake)
    new ses.ConfigurationSetEventDestination(this, 'FirehoseDestination', {
      configurationSet: this.configurationSet,
      configurationSetEventDestinationName: 'firehose',
      events: [
        ses.EmailSendingEvent.SEND,
        ses.EmailSendingEvent.RENDERING_FAILURE,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.DELIVERY_DELAY,
        ses.EmailSendingEvent.OPEN,
        ses.EmailSendingEvent.CLICK,
        ses.EmailSendingEvent.SUBSCRIPTION,
      ],
      destination: ses.EventDestination.firehoseDeliveryStream({
        deliveryStream: deliveryStreamRef,
        role: firehoseRole,
      }),
    });

    // Outputs: DNS records to add in Cloudflare
    new cdk.CfnOutput(this, 'DkimRecord1', {
      value: `CNAME ${this.emailIdentity.dkimDnsTokenName1} -> ${this.emailIdentity.dkimDnsTokenValue1}`,
      description: 'DKIM record 1 (DNS only, grey cloud)',
    });
    new cdk.CfnOutput(this, 'DkimRecord2', {
      value: `CNAME ${this.emailIdentity.dkimDnsTokenName2} -> ${this.emailIdentity.dkimDnsTokenValue2}`,
      description: 'DKIM record 2 (DNS only, grey cloud)',
    });
    new cdk.CfnOutput(this, 'DkimRecord3', {
      value: `CNAME ${this.emailIdentity.dkimDnsTokenName3} -> ${this.emailIdentity.dkimDnsTokenValue3}`,
      description: 'DKIM record 3 (DNS only, grey cloud)',
    });

    new cdk.CfnOutput(this, 'MailFromMxRecord', {
      value: `${config.mailFromSubdomain}.${config.domain} MX 10 feedback-smtp.us-east-1.amazonses.com`,
      description: 'Custom MAIL FROM MX record',
    });

    new cdk.CfnOutput(this, 'MailFromSpfRecord', {
      value: `${config.mailFromSubdomain}.${config.domain} TXT "v=spf1 include:amazonses.com -all"`,
      description: 'Custom MAIL FROM SPF record',
    });

    new cdk.CfnOutput(this, 'DmarcRecord', {
      value: `_dmarc.${config.domain} TXT "v=DMARC1; p=none; rua=mailto:dmarc@${config.optoutSubdomain}.${config.domain},mailto:${config.replyToAddress}; fo=1"`,
      description: 'DMARC record (monitoring only for now)',
    });

    new cdk.CfnOutput(this, 'TrackingDomainRecord', {
      value: `${config.trackingSubdomain}.${config.domain} CNAME -> <lookup in SES console after deploy>`,
      description: 'SES tracking domain CNAME target (shown in SES console)',
    });

    new cdk.CfnOutput(this, 'SesSandboxWarning', {
      value: 'SES is currently in sandbox. Request production access before sending to the full list.',
    });
  }
}
