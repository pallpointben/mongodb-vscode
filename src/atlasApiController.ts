import * as vscode from 'vscode';

import { createLogger } from './logging';
import { AtlasStorage } from './storage/atlasStorage';
import type { StorageController } from './storage';

const log = createLogger('Atlas API controller');

const ACCEPT_HEADER = 'application/vnd.atlas.2024-08-05+json';
const BASE_URL = 'https://cloud-dev.mongodb.com/api/atlas/v2/';
const AUTH_URL = 'https://cloud-dev.mongodb.com/api/oauth/token';
const BASE_WEB_URL = 'https://cloud-dev.mongodb.com/v2/';

interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

interface AtlasProject {
  id: string;
  name: string;
  clusterCount: number;
}
interface ProjectsResponseBody {
  totalCount: number;
  results: AtlasProject[];
}

interface ReplicationSpec {
  regionConfigs: {
    electableSpecs: {
      instanceSize: string;
      nodeCount: number;
    };
  }[];
}

interface AtlasCluster {
  name: string;
  id: string;
  connectionStrings: {
    standard: string;
    standardSrv: string;
  };
  replicationSpecs: ReplicationSpec[];
}

interface ClustersResponseBody {
  totalCount: number;
  results: AtlasCluster[];
}

type RecommendationType =
  | 'REDUCE_LOOKUP_OPS'
  | 'AVOID_UNBOUNDED_ARRAY'
  | 'REDUCE_DOCUMENT_SIZE'
  | 'REMOVE_UNNECESSARY_INDEXES'
  | 'REDUCE_NUMBER_OF_NAMESPACES'
  | 'OPTIMIZE_CASE_INSENSITIVE_REGEX_QUERIES'
  | 'OPTIMIZE_TEXT_QUERIES';

type TriggerType =
  | 'PERCENT_QUERIES_USE_LOOKUP'
  | 'NUMBER_OF_QUERIES_USE_LOOKUP'
  | 'DOCS_CONTAIN_UNBOUNDED_ARRAY'
  | 'NUMBER_OF_NAMESPACES'
  | 'DOC_SIZE_TOO_LARGE'
  | 'NUM_INDEXES'
  | 'QUERIES_CONTAIN_CASE_INSENSITIVE_REGEX';

interface SchemaAdviceResponseBody {
  status: number;
  content: {
    recommendations: {
      affectedNamespaces: {
        namespace: string | null;
        triggers: {
          description: string;
          triggerType: TriggerType;
        }[];
      }[];
      description: string;
      recommendation: RecommendationType;
    }[];
  };
}

interface SuggestedIndexesResponseBody {
  status: number;
  content: {
    shapes: {
      avgMs: number;
      count: string;
      inefficiencyScore: number;
      namespace: string;
      operations: {
        predicates: unknown[];
        stats: {
          ms: number;
          nReturned: number;
          nScanned: number;
          ts: number;
        };
      };
    }[];
    suggestedIndexes: {
      avgObjSize: number;
      impact: string[];
      index: { name: string }[];
      /** database.collection */
      namespace: string;
      weight: number;
    }[];
  };
}

export type SchemaAdvice = SchemaAdviceResponseBody['content'];
export type SuggestedIndexes = SuggestedIndexesResponseBody['content'];

export default class AtlasApiController {
  private _clientCreds: ClientCreds | null = null;
  private _tokenData: { accessToken: string; expiresAt: Date } | null = null;
  private _atlasStorage: AtlasStorage;
  private _projectId: string | null = null;

  static isAtlasConnectionString(connectionString: string): boolean {
    const parsed = new URL(connectionString);
    return (
      parsed.protocol === 'mongodb+srv:' &&
      (parsed.hostname.endsWith('.mongodb.net') ||
        parsed.hostname.endsWith('.mongodb-dev.net'))
    );
  }

  static buildPerformanceAdvisorUrl(
    groupId: string,
    clusterName: string,
  ): string {
    return `${BASE_WEB_URL}${groupId}#/metrics/atlasRedirect/${clusterName}?${new URLSearchParams({ path: '<rootMetricsRoute>/advisor' })}`;
  }

  constructor({ storageController }: { storageController: StorageController }) {
    this._atlasStorage = new AtlasStorage({
      storageController,
    });
  }

  async isOptedIn(): Promise<boolean> {
    const optedIn = this._atlasStorage.getStoredOptedIn();
    log.info('Opted in:', optedIn);
    if (optedIn === null) {
      const response = await vscode.window.showInformationMessage(
        "We've detected that you appear to be using a cluster from MongoDB Atlas.\n" +
          'Would you like to allow API access to your Atlas project for additional insights? ' +
          'This will require you to set up a Service Account in your Atlas project.\n' +
          'You can opt out of this at any time by changing the "mdb.atlas.optedIn" setting in your workspace settings.',
        { modal: true },
        { title: 'Yes' },
        { title: 'No' },
      );
      if (response === undefined) {
        // User closed the input box/clicked "Cancel".
        // Don't store the response, but treat it as "No" for this request
        return false;
      }
      if (response?.title === 'Yes') {
        await this._atlasStorage.setOptedIn(true);
        return true;
      }
      await this._atlasStorage.setOptedIn(false);
      return false;
    }
    return optedIn;
  }

  async _loadOrSaveClientCredsWithInputBox(
    stream?: vscode.ChatResponseStream,
  ): Promise<ClientCreds> {
    if (this._clientCreds) {
      return this._clientCreds;
    }
    const storedClientId = this._atlasStorage.getStoredClientId();
    if (storedClientId) {
      const storedClientSecret =
        await this._atlasStorage.getStoredClientSecret();
      if (storedClientSecret) {
        this._clientCreds = {
          clientId: storedClientId,
          clientSecret: storedClientSecret,
        };
        return this._clientCreds;
      }
    }

    stream?.progress(
      `Please enter your Atlas ${storedClientId === null ? 'Client ID and ' : ''}Client Secret in the input prompts.`,
    );
    const clientId =
      storedClientId ??
      (await vscode.window.showInputBox({
        prompt: 'Enter your Atlas Client ID',
        ignoreFocusOut: true,
      }));
    if (!clientId) {
      throw new Error('Client ID is required');
    }

    const clientSecret = await vscode.window.showInputBox({
      prompt: 'Enter your Atlas Client Secret',
      ignoreFocusOut: true,
    });
    if (!clientSecret) {
      throw new Error('Client Secret is required');
    }

    await this._atlasStorage.setClientId(clientId);
    await this._atlasStorage.setClientSecret(clientSecret);
    this._clientCreds = { clientId, clientSecret };
    return this._clientCreds;
  }

  private async _getClientCreds(
    stream?: vscode.ChatResponseStream,
  ): Promise<ClientCreds> {
    if (!this._clientCreds) {
      return await this._loadOrSaveClientCredsWithInputBox(stream);
    }
    return this._clientCreds;
  }

  private async _refreshAccessToken(
    stream?: vscode.ChatResponseStream,
  ): Promise<void> {
    const { clientId, clientSecret } = await this._getClientCreds(stream);
    const response = await fetch(AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(
          `${clientId}:${clientSecret}`,
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to refresh access token: ${response.statusText}`);
    }
    const data = await response.json();
    this._tokenData = {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  private async _makeRequest(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    body: any = null,
    stream?: vscode.ChatResponseStream,
  ): Promise<Response> {
    if (!this._tokenData || this._tokenData.expiresAt <= new Date()) {
      await this._refreshAccessToken(stream);
    }

    if (!this._tokenData) {
      throw new Error('Failed to refresh access token');
    }

    log.info('Making Atlas request', { endpoint });
    const url = `${BASE_URL}${endpoint}`;
    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this._tokenData.accessToken}`,
        Accept: ACCEPT_HEADER,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : null,
    };

    return fetch(url, options);
  }

  async getProjects(): Promise<ProjectsResponseBody> {
    const response = await this._makeRequest('groups');
    if (!response.ok) {
      const body = await response.text();
      log.error('Failed to fetch projects', {
        statusText: response.statusText,
        body,
      });
      throw new Error(`Failed to fetch projects: ${response.statusText}`);
    }
    return await response.json();
  }

  async getProjectId(): Promise<string | null> {
    if (this._projectId !== null) {
      return this._projectId;
    }
    const projectsBody = await this.getProjects();
    if (projectsBody.totalCount === 0) {
      return null;
    }
    const { results: projects } = projectsBody;
    if (projectsBody.totalCount === 1) {
      log.info('Creds only have access to one project:', projects[0].name, {
        id: projects[0].id,
      });
      this._projectId = projects[0].id;
      return this._projectId;
    }
    const projectNames = projects.map((project) => project.name);
    const selectedProjectName = await vscode.window.showQuickPick(
      projectNames,
      {
        placeHolder: 'Select a project',
        ignoreFocusOut: true,
      },
    );
    if (!selectedProjectName) {
      return null;
    }
    const selectedProject = projects.find(
      (project) => project.name === selectedProjectName,
    );
    if (!selectedProject) {
      return null;
    }
    log.info('User selected project:', selectedProject.name, {
      id: selectedProject.id,
    });
    this._projectId = selectedProject.id;
    return this._projectId;
  }

  async selectCluster(
    projectId?: string | null,
    { connectionString }: { connectionString?: string } = {},
  ): Promise<string | null> {
    if (!projectId) {
      projectId = await this.getProjectId();
      if (!projectId) {
        return null;
      }
    }
    const clustersResponse = await this._makeRequest(
      `groups/${projectId}/clusters`,
    );
    log.info('Clusters response:', clustersResponse);
    if (!clustersResponse.ok) {
      const body = await clustersResponse.text();
      log.error('Failed to fetch clusters', {
        statusText: clustersResponse.statusText,
        body,
      });
      throw new Error(
        `Failed to fetch clusters: ${clustersResponse.statusText}`,
      );
    }
    const clustersBody: ClustersResponseBody = await clustersResponse.json();
    if (clustersBody.totalCount === 0) {
      return null;
    }
    const { results: clusters } = clustersBody;

    // Check if a provided connection string matches any of the clusters
    // and automatically select it if so.
    if (connectionString) {
      const matchingCluster = clusters.find(
        (cluster) =>
          cluster.connectionStrings.standardSrv.includes(connectionString) ||
          connectionString.includes(cluster.connectionStrings.standardSrv),
      );
      if (matchingCluster) {
        log.info('Automatically selected cluster:', matchingCluster.name);
        return matchingCluster.name;
      }
    }

    // If no connection string is provided or no match is found, prompt the user to select a cluster
    const clusterNames = clusters.map((cluster) => cluster.name);
    const selectedClusterName = await vscode.window.showQuickPick(
      clusterNames,
      {
        placeHolder: 'Select a cluster',
        ignoreFocusOut: true,
      },
    );
    if (!selectedClusterName) {
      return null;
    }
    const selectedCluster = clusters.find(
      (cluster) => cluster.name === selectedClusterName,
    );
    if (!selectedCluster) {
      return null;
    }
    log.info('User selected cluster:', selectedCluster.name);
    return selectedCluster.name;
  }

  async fetchSchemaAdvice(
    groupId: string,
    clusterName: string,
    stream?: vscode.ChatResponseStream,
  ): Promise<SchemaAdviceResponseBody> {
    const endpoint = `groups/${groupId}/clusters/${clusterName}/performanceAdvisor/schemaAdvice`;
    const response = await this._makeRequest(
      endpoint,
      'GET',
      undefined,
      stream,
    );
    if (!response.ok) {
      const body = await response.text();
      log.error('Failed to fetch schema advice', {
        statusText: response.statusText,
        body,
      });
      throw new Error(`Failed to fetch schema advice: ${response.statusText}`);
    }
    return await response.json();
  }
  async fetchSuggestedIndexes(
    groupId: string,
    clusterName: string,
    stream?: vscode.ChatResponseStream,
  ): Promise<SuggestedIndexesResponseBody> {
    const endpoint = `groups/${groupId}/clusters/${clusterName}/performanceAdvisor/suggestedIndexes`;
    const response = await this._makeRequest(
      endpoint,
      'GET',
      undefined,
      stream,
    );
    if (!response.ok) {
      const body = await response.text();
      log.error('Failed to fetch suggested indexes', {
        statusText: response.statusText,
        body,
      });
      throw new Error(
        `Failed to fetch suggested indexes: ${response.statusText}`,
      );
    }
    return await response.json();
  }
}
