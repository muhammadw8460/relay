import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface BootstrapStackProps extends StackProps {
  /** owner/repo allowed to assume the deploy role. */
  githubRepo: string;
  /** Branch allowed to deploy. */
  branch?: string;
  /** Pass an existing GitHub OIDC provider ARN if the account already has one (only one is allowed per URL). */
  existingOidcProviderArn?: string;
  /** If set, creates a monthly cost budget that emails this address at 80% and 100% of the limit. */
  budgetEmail?: string;
  budgetLimitUsd?: number;
}

/**
 * One-time, account-level setup, deployed by hand with your own credentials:
 * - GitHub Actions OIDC provider + a deploy role scoped to one repo and branch
 *   (no long-lived AWS keys in GitHub)
 * - an optional monthly AWS Budget alert
 */
export class BootstrapStack extends Stack {
  constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id, props);
    const branch = props.branch ?? 'main';

    const providerArn =
      props.existingOidcProviderArn ??
      new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      }).openIdConnectProviderArn;

    const role = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'relay-github-deploy',
      description: `Assumed by GitHub Actions in ${props.githubRepo} (${branch}) to deploy Relay`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:ref:refs/heads/${branch}` },
      }),
    });

    // CDK deploys through the roles created by `cdk bootstrap`; this role only needs to assume them.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*`],
      }),
    );
    // Post-deploy smoke/integration tests read stack outputs and audit the orders table.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/Relay-*/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Scan', 'dynamodb:GetItem'],
        resources: [`arn:${this.partition}:dynamodb:${this.region}:${this.account}:table/relay-*-orders`],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', {
      value: role.roleArn,
      description: 'Set as the AWS_DEPLOY_ROLE_ARN repository variable in GitHub',
    });

    if (props.budgetEmail) {
      const limit = props.budgetLimitUsd ?? 5;
      const subscribers = [{ subscriptionType: 'EMAIL', address: props.budgetEmail }];
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: `relay-monthly-${limit}usd`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: limit, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          {
            notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 },
            subscribers,
          },
          {
            notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100 },
            subscribers,
          },
        ],
      });
    }
  }
}
