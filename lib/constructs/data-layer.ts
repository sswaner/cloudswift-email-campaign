import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { EmailCampaignConfig } from '../config';

export interface DataLayerProps {
  config: EmailCampaignConfig;
}

export class DataLayer extends Construct {
  public readonly eventBucket: s3.Bucket;
  public readonly listBucket: s3.Bucket;
  public readonly inboundBucket: s3.Bucket;
  public readonly encryptionKey: kms.Key;

  // DynamoDB tables
  public readonly sendingDomainsTable: dynamodb.Table;
  public readonly listsTable: dynamodb.Table;
  public readonly campaignsTable: dynamodb.Table;
  public readonly recipientsTable: dynamodb.Table;
  public readonly suppressionTable: dynamodb.Table;
  public readonly subscriptionLedgerTable: dynamodb.Table;
  public readonly warmupPlansTable: dynamodb.Table;
  public readonly seedMailboxesTable: dynamodb.Table;
  public readonly placementResultsTable: dynamodb.Table;
  public readonly unsubTokensRevokedTable: dynamodb.Table;

  public readonly glueDatabase: glue.CfnDatabase;

  constructor(scope: Construct, id: string, props: DataLayerProps) {
    super(scope, id);
    const { config } = props;

    this.encryptionKey = new kms.Key(this, 'KmsKey', {
      enableKeyRotation: true,
      description: 'Encryption key for Cloudswift Email Campaign data',
    });

    // S3 buckets
    this.eventBucket = new s3.Bucket(this, 'EventBucket', {
      bucketName: `${config.tenantName}-email-events-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      lifecycleRules: [
        {
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) },
          ],
        },
      ],
    });

    this.listBucket = new s3.Bucket(this, 'ListBucket', {
      bucketName: `${config.tenantName}-email-lists-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      lifecycleRules: [
        { expiration: cdk.Duration.days(365) },
      ],
    });

    this.inboundBucket = new s3.Bucket(this, 'InboundBucket', {
      bucketName: `${config.tenantName}-email-inbound-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      lifecycleRules: [
        { expiration: cdk.Duration.days(90) },
      ],
    });

    // DynamoDB tables — on-demand billing, KMS-encrypted
    const tableDefaults: Partial<dynamodb.TableProps> = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    };

    this.sendingDomainsTable = new dynamodb.Table(this, 'SendingDomains', {
      ...tableDefaults,
      tableName: `${config.tenantName}-sending-domains`,
      partitionKey: { name: 'domain_id', type: dynamodb.AttributeType.STRING },
    });

    this.listsTable = new dynamodb.Table(this, 'Lists', {
      ...tableDefaults,
      tableName: `${config.tenantName}-lists`,
      partitionKey: { name: 'list_id', type: dynamodb.AttributeType.STRING },
    });

    this.campaignsTable = new dynamodb.Table(this, 'Campaigns', {
      ...tableDefaults,
      tableName: `${config.tenantName}-campaigns`,
      partitionKey: { name: 'campaign_id', type: dynamodb.AttributeType.STRING },
    });

    this.recipientsTable = new dynamodb.Table(this, 'Recipients', {
      ...tableDefaults,
      tableName: `${config.tenantName}-recipients`,
      partitionKey: { name: 'campaign_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'recipient_id', type: dynamodb.AttributeType.STRING },
    });
    this.recipientsTable.addGlobalSecondaryIndex({
      indexName: 'by-status',
      partitionKey: { name: 'campaign_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });

    this.suppressionTable = new dynamodb.Table(this, 'Suppression', {
      ...tableDefaults,
      tableName: `${config.tenantName}-suppression`,
      partitionKey: { name: 'email_hash', type: dynamodb.AttributeType.STRING },
    });

    this.subscriptionLedgerTable = new dynamodb.Table(this, 'SubscriptionLedger', {
      ...tableDefaults,
      tableName: `${config.tenantName}-subscription-ledger`,
      partitionKey: { name: 'email_hash', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ts_event_id', type: dynamodb.AttributeType.STRING },
    });

    this.warmupPlansTable = new dynamodb.Table(this, 'WarmupPlans', {
      ...tableDefaults,
      tableName: `${config.tenantName}-warmup-plans`,
      partitionKey: { name: 'identity', type: dynamodb.AttributeType.STRING },
    });

    this.seedMailboxesTable = new dynamodb.Table(this, 'SeedMailboxes', {
      ...tableDefaults,
      tableName: `${config.tenantName}-seed-mailboxes`,
      partitionKey: { name: 'seed_id', type: dynamodb.AttributeType.STRING },
    });

    this.placementResultsTable = new dynamodb.Table(this, 'PlacementResults', {
      ...tableDefaults,
      tableName: `${config.tenantName}-placement-results`,
      partitionKey: { name: 'campaign_seed_id', type: dynamodb.AttributeType.STRING },
    });

    this.unsubTokensRevokedTable = new dynamodb.Table(this, 'UnsubTokensRevoked', {
      ...tableDefaults,
      tableName: `${config.tenantName}-unsub-tokens-revoked`,
      partitionKey: { name: 'kid', type: dynamodb.AttributeType.STRING },
    });

    // Glue database for Athena
    this.glueDatabase = new glue.CfnDatabase(this, 'EventDatabase', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: {
        name: `${config.tenantName}_email_events`,
        description: 'Email campaign event lake',
      },
    });

    // Glue table for raw SES-style events (JSON, GZIP)
    new glue.CfnTable(this, 'RawEventsTable', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseName: this.glueDatabase.ref,
      tableInput: {
        name: 'raw_events',
        description: 'Raw email events from SES, dispatcher, unsubscribe, and import',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          classification: 'json',
          'compressionType': 'gzip',
          'typeOfData': 'file',
        },
        storageDescriptor: {
          location: `s3://${this.eventBucket.bucketName}/raw-events/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
          },
          columns: [
            { name: 'event_id', type: 'string' },
            { name: 'event_type', type: 'string' },
            { name: 'source', type: 'string' },
            { name: 'ts', type: 'string' },
            { name: 'domain_id', type: 'string' },
            { name: 'campaign_id', type: 'string' },
            { name: 'list_id', type: 'string' },
            { name: 'recipient_id', type: 'string' },
            { name: 'recipient_domain', type: 'string' },
            { name: 'ses_message_id', type: 'string' },
            { name: 'detail', type: 'string' },
          ],
        },
        partitionKeys: [
          { name: 'domain_id', type: 'string' },
          { name: 'dt', type: 'string' },
        ],
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'EventBucketName', { value: this.eventBucket.bucketName });
    new cdk.CfnOutput(this, 'ListBucketName', { value: this.listBucket.bucketName });
    new cdk.CfnOutput(this, 'InboundBucketName', { value: this.inboundBucket.bucketName });
    new cdk.CfnOutput(this, 'GlueDatabaseName', { value: this.glueDatabase.ref });
  }
}
