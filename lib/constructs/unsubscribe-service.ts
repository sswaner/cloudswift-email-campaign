import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaRuntime from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2int from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EmailCampaignConfig } from '../config';

export interface UnsubscribeServiceProps {
  config: EmailCampaignConfig;
  eventBucket: s3.IBucket;
  listBucket: s3.IBucket;
  inboundBucket: s3.IBucket;
  recipientsTable: dynamodb.ITable;
  suppressionTable: dynamodb.ITable;
  subscriptionLedgerTable: dynamodb.ITable;
}

export class UnsubscribeService extends Construct {
  public readonly unsubTokensTable: dynamodb.Table;
  public readonly api: apigwv2.HttpApi;
  public readonly tokenKeysSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: UnsubscribeServiceProps) {
    super(scope, id);
    const { config, eventBucket, inboundBucket, recipientsTable, suppressionTable, subscriptionLedgerTable } = props;

    // Allow SES to write inbound mail to the bucket
    inboundBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSESPutObject',
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [inboundBucket.arnForObjects('optout/*')],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': cdk.Aws.ACCOUNT_ID,
          },
        },
      }),
    );

    // Token signing keys in Secrets Manager
    this.tokenKeysSecret = new secretsmanager.Secret(this, 'TokenKeys', {
      description: 'HMAC keys for unsubscribe tokens (kid -> base64url key)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ key1: '' }),
        generateStringKey: 'key1',
        excludePunctuation: true,
        includeSpace: false,
        passwordLength: 64,
      },
    });

    // DynamoDB table mapping short mailto tokens to recipients
    this.unsubTokensTable = new dynamodb.Table(this, 'UnsubTokens', {
      tableName: `${config.tenantName}-unsub-tokens`,
      partitionKey: { name: 'mailto_token', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Shared Lambda environment
    const lambdaEnv: { [key: string]: string } = {
      UNSUB_TOKENS_TABLE: this.unsubTokensTable.tableName,
      RECIPIENTS_TABLE: recipientsTable.tableName,
      SUPPRESSION_TABLE: suppressionTable.tableName,
      SUBSCRIPTION_LEDGER_TABLE: subscriptionLedgerTable.tableName,
      EVENT_BUCKET: eventBucket.bucketName,
      TOKEN_KEYS_SECRET_ARN: this.tokenKeysSecret.secretArn,
      DOMAIN_ID: config.domain,
    };

    // Unsubscribe API Lambda
    const unsubFn = new lambda.NodejsFunction(this, 'UnsubFunction', {
      entry: 'lambda/unsub/index.ts',
      handler: 'handler',
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });
    this.unsubTokensTable.grantReadData(unsubFn);
    recipientsTable.grantReadWriteData(unsubFn);
    suppressionTable.grantReadWriteData(unsubFn);
    subscriptionLedgerTable.grantWriteData(unsubFn);
    eventBucket.grantWrite(unsubFn);
    this.tokenKeysSecret.grantRead(unsubFn);

    // Mailto Lambda
    const mailtoFn = new lambda.NodejsFunction(this, 'MailtoFunction', {
      entry: 'lambda/mailto/index.ts',
      handler: 'handler',
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });
    this.unsubTokensTable.grantReadData(mailtoFn);
    recipientsTable.grantReadData(mailtoFn);
    suppressionTable.grantReadWriteData(mailtoFn);
    subscriptionLedgerTable.grantWriteData(mailtoFn);
    eventBucket.grantWrite(mailtoFn);
    inboundBucket.grantRead(mailtoFn);

    // API Gateway HTTP API
    this.api = new apigwv2.HttpApi(this, 'UnsubApi', {
      apiName: `${config.tenantName}-unsub-api`,
      defaultIntegration: new apigwv2int.HttpLambdaIntegration('UnsubIntegration', unsubFn),
    });

    // Custom domain for unsub.lexara.vip (disabled until Cloudflare DNS validation is available)
    if (config.enableCustomDomain) {
      const unsubDomain = `${config.unsubSubdomain}.${config.domain}`;
      const certificate = new acm.Certificate(this, 'UnsubCertificate', {
        domainName: unsubDomain,
        validation: acm.CertificateValidation.fromDns(),
      });

      const customDomain = new apigwv2.DomainName(this, 'UnsubDomain', {
        domainName: unsubDomain,
        certificate,
      });
      new apigwv2.ApiMapping(this, 'UnsubApiMapping', {
        api: this.api,
        domainName: customDomain,
        stage: this.api.defaultStage,
      });

      new cdk.CfnOutput(this, 'UnsubDomainRecord', {
        value: `${unsubDomain} CNAME -> ${customDomain.regionalDomainName}`,
        description: 'Unsubscribe service CNAME record',
      });

      new cdk.CfnOutput(this, 'UnsubCertificateValidation', {
        value: `Certificate ARN: ${certificate.certificateArn}. Add the ACM validation CNAME records shown in the AWS console to Cloudflare.`,
        description: 'ACM certificate validation records (look up in console)',
      });
    }

    // WAF is not supported directly on HTTP APIs; use CloudFront or API Gateway throttling in a later phase.

    // SES inbound receipt rule: u-*@optout.lexara.vip -> S3 -> Lambda
    const ruleSet = new ses.ReceiptRuleSet(this, 'InboundRuleSet', {
      receiptRuleSetName: `${config.tenantName}-inbound-rules`,
    });

    ruleSet.addRule('OptoutRule', {
      recipients: [`u-*@${config.optoutSubdomain}.${config.domain}`],
      actions: [
        new sesActions.S3({
          bucket: inboundBucket,
          objectKeyPrefix: 'optout/',
        }),
        new sesActions.Lambda({
          function: mailtoFn,
          invocationType: sesActions.LambdaInvocationType.EVENT,
        }),
      ],
      scanEnabled: true,
    });

    // S3 notification as fallback (receipt rule Lambda action is primary)
    inboundBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(mailtoFn), {
      prefix: 'optout/',
    });

    // Outputs
    new cdk.CfnOutput(this, 'UnsubApiEndpoint', {
      value: this.api.apiEndpoint,
      description: 'Unsubscribe API endpoint (use until custom domain is enabled)',
    });

    new cdk.CfnOutput(this, 'OptoutMxRecord', {
      value: `${config.optoutSubdomain}.${config.domain} MX 10 inbound-smtp.us-east-1.amazonaws.com`,
      description: 'Optout inbound mail MX record',
    });
  }
}
