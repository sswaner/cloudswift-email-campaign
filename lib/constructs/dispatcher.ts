import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EmailCampaignConfig } from '../config';

export interface DispatcherProps {
  config: EmailCampaignConfig;
  recipientsTable: dynamodb.Table;
  unsubTokensTable: dynamodb.Table;
  contactsTable: dynamodb.Table;
  domainId: string;
}

export class Dispatcher extends Construct {
  public readonly function: lambda.NodejsFunction;
  public readonly scheduler: events.Rule;

  constructor(scope: Construct, id: string, props: DispatcherProps) {
    super(scope, id);
    const { config, recipientsTable, unsubTokensTable, contactsTable, domainId } = props;

    this.function = new lambda.NodejsFunction(this, 'DispatcherFunction', {
      entry: 'lambda/dispatcher/index.ts',
      handler: 'handler',
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        FROM_ADDRESS: `${config.fromDisplayName} <${config.fromLocalPart}@${config.domain}>`,
        REPLY_TO_ADDRESS: config.replyToAddress,
        CONFIGURATION_SET_NAME: config.configurationSetName,
        RECIPIENTS_TABLE: recipientsTable.tableName,
        UNSUB_TOKENS_TABLE: unsubTokensTable.tableName,
        CONTACTS_TABLE: contactsTable.tableName,
        DOMAIN_ID: domainId,
        MAX_PER_INVOCATION: '1',
        SEND_WINDOW_TIMEZONE: config.sendWindow.timezone,
        SEND_WINDOW_START: config.sendWindow.startLocal,
        SEND_WINDOW_END: config.sendWindow.endLocal,
        SEND_WINDOW_DAYS: config.sendWindow.days.join(','),
        UNSUB_DOMAIN: config.unsubSubdomain ? `${config.unsubSubdomain}.${config.domain}` : config.domain,
        OPTOUT_DOMAIN: `${config.optoutSubdomain}.${config.domain}`,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'es2022',
      },
    });

    recipientsTable.grantReadData(this.function);
    recipientsTable.grantWriteData(this.function);
    unsubTokensTable.grantWriteData(this.function);
    contactsTable.grantReadData(this.function);

    // SES v2 send permissions
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      }),
    );

    // EventBridge Rule — invoke every minute (use EventBridge Scheduler for sub-minute)
    this.scheduler = new events.Rule(this, 'DispatcherSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      description: 'Paced email dispatch scheduler',
    });
    this.scheduler.addTarget(new targets.LambdaFunction(this.function));
  }
}
