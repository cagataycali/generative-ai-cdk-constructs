/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as oss from 'aws-cdk-lib/aws-opensearchserverless';
import { Construct } from 'constructs';
import { buildCustomResourceProvider } from '../../common/helpers/custom-resource-provider-helper';
import { generatePhysicalNameV2 } from '../../common/helpers/utils';
import { VectorCollection } from '../opensearchserverless';
import {
  CharacterFilterType,
  TokenFilterType,
  TokenizerType,
} from '../opensearchserverless/analysis-plugins';

/**
 * Metadata field definitions.
 */
export interface MetadataManagementFieldProps {
  /**
   * The name of the field.
   */
  readonly mappingField: string;
  /**
   * The data type of the field.
   */
  readonly dataType: string;
  /**
   * Whether the field is filterable.
   */
  readonly filterable: boolean;
}

/**
 * Properties for the Analyzer.
 */
export interface Analyzer {
  /**
   * The analyzers to use.
   */
  readonly characterFilters: CharacterFilterType[];
  /**
   * The tokenizer to use.
   */
  readonly tokenizer: TokenizerType;
  /**
   * The token filters to use.
   */
  readonly tokenFilters: TokenFilterType[];
}

/**
 * Properties for the VectorIndex.
 */
export interface VectorIndexProps {
  /**
   * The OpenSearch Vector Collection.
   */
  readonly collection: VectorCollection;
  /**
   * The name of the index.
   */
  readonly indexName: string;
  /**
   * The name of the vector field.
   */
  readonly vectorField: string;
  /**
   * The number of dimensions in the vector.
   */
  readonly vectorDimensions: number;
  /**
   * The metadata management fields.
   */
  readonly mappings: MetadataManagementFieldProps[];
  /**
   * The analyzer to use.
   * @default - No analyzer.
   */
  readonly analyzer?: Analyzer;
  /**
   * The engine to use for vector search.
   * @default 'faiss'
   */
  readonly engine?: string;
  /**
   * The space type for vector search.
   * @default 'l2'
   */
  readonly spaceType?: string;
  /**
   * The method name for vector search.
   * @default 'hnsw'
   */
  readonly methodName?: string;
  /**
   * Additional parameters for vector search.
   * @default {}
   */
  readonly parameters?: Record<string, any>;
  /**
   * The number of shards for the index.
   * @default 2
   */
  readonly numberOfShards?: number;
  /**
   * The ef_search parameter for vector search.
   * @default 512
   */
  readonly efSearch?: number;
  /**
   * Custom settings for the index.
   * @default {}
   */
  readonly customSettings?: Record<string, any>;
}

/**
 * Deploy a vector index on the collection.
 */
export class VectorIndex extends cdk.Resource {
  /**
   * The name of the index.
   */
  public readonly indexName: string;
  /**
   * The name of the vector field.
   */
  public readonly vectorField: string;
  /**
   * The number of dimensions in the vector.
   */
  public readonly vectorDimensions: number;

  constructor(scope: Construct, id: string, props: VectorIndexProps) {
    super(scope, id);

    this.indexName = props.indexName;
    this.vectorField = props.vectorField;
    this.vectorDimensions = props.vectorDimensions;

    const crProvider = OpenSearchIndexCRProvider.getProvider(this);
    crProvider.role.addManagedPolicy(props.collection.aossPolicy);

    const manageIndexPolicyName = generatePhysicalNameV2(
      this,
      'ManageIndexPolicy',
      { maxLength: 32, lower: true },
    );
    const manageIndexPolicy = new oss.CfnAccessPolicy(
      this,
      'ManageIndexPolicy',
      {
        name: manageIndexPolicyName,
        type: 'data',
        policy: JSON.stringify([
          {
            Rules: [
              {
                Resource: [`index/${props.collection.collectionName}/*`],
                Permission: [
                  'aoss:DescribeIndex',
                  'aoss:CreateIndex',
                  'aoss:DeleteIndex',
                  'aoss:UpdateIndex',
                ],
                ResourceType: 'index',
              },
              {
                Resource: [`collection/${props.collection.collectionName}`],
                Permission: ['aoss:DescribeCollectionItems'],
                ResourceType: 'collection',
              },
            ],
            Principal: [crProvider.role.roleArn],
            Description: '',
          },
        ]),
      },
    );

    const analyzerProps = props.analyzer
      ? {
        CharacterFilters: props.analyzer.characterFilters,
        Tokenizer: props.analyzer.tokenizer,
        TokenFilters: props.analyzer.tokenFilters,
      }
      : undefined;

    const vectorIndex = new cdk.CustomResource(this, 'VectorIndex', {
      serviceToken: crProvider.serviceToken,
      properties: {
        CollectionName: props.collection.collectionName,
        Endpoint: `${props.collection.collectionId}.${cdk.Stack.of(this).region}.aoss.amazonaws.com`,
        IndexName: props.indexName,
        VectorField: props.vectorField,
        VectorDimension: props.vectorDimensions,
        Engine: props.engine || 'faiss',
        SpaceType: props.spaceType || 'l2',
        MethodName: props.methodName || 'hnsw',
        Parameters: JSON.stringify(props.parameters || {}),
        NumberOfShards: props.numberOfShards || 2,
        EfSearch: props.efSearch || 512,
        CustomSettings: JSON.stringify(props.customSettings || {}),
        MetadataManagement: props.mappings.map((m) => ({
          MappingField: m.mappingField,
          DataType: m.dataType,
          Filterable: m.filterable,
        })),
        Analyzer: analyzerProps,
      },
      resourceType: 'Custom::OpenSearchIndex',
    });

    vectorIndex.node.addDependency(manageIndexPolicy);
    vectorIndex.node.addDependency(props.collection);
    vectorIndex.node.addDependency(props.collection.dataAccessPolicy);
  }
}

/**
 * Custom Resource provider for OpenSearch Index operations.
 *
 * @internal This is an internal core function and should not be called directly by Solutions Constructs clients.
 */
export const OpenSearchIndexCRProvider = buildCustomResourceProvider({
  providerName: 'OpenSearchIndexCRProvider',
  codePath: path.join(__dirname, '../../../lambda/opensearch-serverless-custom-resources/index.ts'),
  handler: 'handler',
  runtime: lambda.Runtime.NODEJS_18_X,
});