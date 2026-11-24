#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CloudswiftEmailCampaignStack } from '../lib/cloudswift-email-campaign-stack';

const app = new cdk.App();
new CloudswiftEmailCampaignStack(app, 'CloudswiftEmailCampaignStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Cloudswift Email Campaign: paced bulk sender on Amazon SES',
});
