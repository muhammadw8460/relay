#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { BootstrapStack } from '../lib/bootstrap-stack';
import { RelayStack } from '../lib/relay-stack';

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};
const ctx = (key: string): string | undefined => app.node.tryGetContext(key);

const stage = ctx('stage') ?? 'dev';
new RelayStack(app, `Relay-${stage}`, {
  env,
  stage,
  alarmEmail: ctx('alarmEmail'),
  transientFailureRate: ctx('transientFailureRate') !== undefined ? Number(ctx('transientFailureRate')) : undefined,
  outOfStockRate: ctx('outOfStockRate') !== undefined ? Number(ctx('outOfStockRate')) : undefined,
});

new BootstrapStack(app, 'RelayBootstrap', {
  env,
  githubRepo: ctx('githubRepo') ?? 'muhammadw8460/relay',
  existingOidcProviderArn: ctx('existingOidcProviderArn'),
  budgetEmail: ctx('budgetEmail'),
  budgetLimitUsd: ctx('budgetLimitUsd') !== undefined ? Number(ctx('budgetLimitUsd')) : undefined,
});

Tags.of(app).add('project', 'relay');
