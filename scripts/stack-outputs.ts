import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export interface RelayOutputs {
  ApiUrl: string;
  TableName: string;
  QueueUrl: string;
  DlqUrl: string;
}

const KEYS: (keyof RelayOutputs)[] = ['ApiUrl', 'TableName', 'QueueUrl', 'DlqUrl'];

/**
 * Resolves the deployed stack's outputs, in order of preference:
 * 1. env vars API_URL / TABLE_NAME / QUEUE_URL / DLQ_URL (all four set)
 * 2. cdk-outputs.json written by `cdk deploy --outputs-file`
 * 3. CloudFormation DescribeStacks
 */
export async function stackOutputs(stage = process.env.STAGE ?? 'dev'): Promise<RelayOutputs> {
  const stackName = `Relay-${stage}`;
  const fromEnv = {
    ApiUrl: process.env.API_URL,
    TableName: process.env.TABLE_NAME,
    QueueUrl: process.env.QUEUE_URL,
    DlqUrl: process.env.DLQ_URL,
  };
  if (KEYS.every((k) => fromEnv[k])) return fromEnv as RelayOutputs;

  const file = path.join(__dirname, '..', 'cdk-outputs.json');
  if (existsSync(file)) {
    const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Partial<RelayOutputs>>;
    const outputs = all[stackName];
    if (outputs && KEYS.every((k) => outputs[k])) return { ...(outputs as RelayOutputs), ...stripUndefined(fromEnv) };
  }

  const cfn = new CloudFormationClient({});
  const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = Object.fromEntries((res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
  for (const k of KEYS) {
    if (!outputs[k]) throw new Error(`Stack ${stackName} has no output ${k}. Is it deployed?`);
  }
  return { ...(outputs as unknown as RelayOutputs), ...stripUndefined(fromEnv) };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);
