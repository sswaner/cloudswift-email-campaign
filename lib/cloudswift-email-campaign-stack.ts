import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { lexaraConfig } from './config';
import { DataLayer } from './constructs/data-layer';
import { SesFoundation } from './constructs/ses-foundation';
import { UnsubscribeService } from './constructs/unsubscribe-service';

export class CloudswiftEmailCampaignStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const config = lexaraConfig;

    // Data layer: S3, DynamoDB, Glue/Athena
    const dataLayer = new DataLayer(this, 'DataLayer', { config });

    // SES foundation: identity, config set, event destinations
    new SesFoundation(this, 'SesFoundation', {
      config,
      eventBucket: dataLayer.eventBucket,
    });

    // Unsubscribe service: API, mailto parsing, suppression ledger
    new UnsubscribeService(this, 'UnsubscribeService', {
      config,
      eventBucket: dataLayer.eventBucket,
      listBucket: dataLayer.listBucket,
      inboundBucket: dataLayer.inboundBucket,
      contactsTable: dataLayer.contactsTable,
      recipientsTable: dataLayer.recipientsTable,
      suppressionTable: dataLayer.suppressionTable,
      subscriptionLedgerTable: dataLayer.subscriptionLedgerTable,
    });

    // Tags
    cdk.Tags.of(this).add('Project', 'cloudswift-email-campaign');
    cdk.Tags.of(this).add('Tenant', config.tenantName);
  }
}
