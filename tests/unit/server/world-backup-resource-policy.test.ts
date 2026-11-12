import { expect, test } from 'vitest';
import restorePolicy from '../../../config/aws/world-backups/restore-policy.json' with {
  type: 'json',
};
import stackPolicy from '../../../config/aws/world-backups/stack-policy.json' with { type: 'json' };
import template from '../../../config/aws/world-backups/template.json' with { type: 'json' };
import uploaderPolicy from '../../../config/aws/world-backups/uploader-policy.json' with {
  type: 'json',
};

test('the reviewable resource policy retains a private encrypted create-only bucket with the selected retention and minimal separate access', () => {
  expect(template.Resources.WorldBackups).toMatchObject({
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      LifecycleConfiguration: {
        Rules: [
          { Status: 'Enabled', Prefix: 'daily/', ExpirationInDays: 30 },
          { Status: 'Enabled', Prefix: 'weekly/', ExpirationInDays: 84 },
        ],
      },
    },
  });
  expect(template.Resources.WorldBackupPolicy.Properties.PolicyDocument.Statement).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Effect: 'Deny',
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      }),
      expect.objectContaining({
        Effect: 'Deny',
        Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption': 'AES256' } },
      }),
      expect.objectContaining({
        Effect: 'Deny',
        Condition: { Null: { 's3:if-none-match': 'true' } },
      }),
    ])
  );
  expect(stackPolicy.Statement).toContainEqual(
    expect.objectContaining({
      Effect: 'Deny',
      Action: ['Update:Replace', 'Update:Delete'],
      Resource: ['LogicalResourceId/WorldBackups', 'LogicalResourceId/WorldBackupPolicy'],
    })
  );
  expect(uploaderPolicy.Statement.map((statement) => statement.Action)).toEqual([
    ['s3:PutObject', 's3:GetObject'],
  ]);
  expect(restorePolicy.Statement.map((statement) => statement.Action)).toEqual(['s3:GetObject']);
});
