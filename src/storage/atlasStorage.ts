import * as vscode from 'vscode';
import type StorageController from './storageController';
import { StorageLocation, StorageVariables } from './storageController';

export class AtlasStorage {
  _storageController: StorageController;

  constructor({ storageController }: { storageController: StorageController }) {
    this._storageController = storageController;
  }

  getStoredOptedIn(): boolean | null {
    return vscode.workspace.getConfiguration().get('mdb.atlas.optedIn') ?? null;
  }
  async setOptedIn(optedIn: boolean): Promise<void> {
    return vscode.workspace
      .getConfiguration()
      .update(
        'mdb.atlas.optedIn',
        optedIn,
        vscode.ConfigurationTarget.Workspace,
      );
  }

  getStoredClientId(): string | null {
    return (
      this._storageController.get(
        StorageVariables.ATLAS_CLIENT_ID,
        StorageLocation.WORKSPACE,
      ) ?? null
    );
  }
  getStoredClientSecret(): Promise<string | null> {
    const clientId = this.getStoredClientId();
    if (!clientId) {
      return Promise.resolve(null);
    }
    return this._storageController.getSecret('atlasClientSecret_' + clientId);
  }
  async setClientId(clientId: string): Promise<void> {
    return await this._storageController.update(
      StorageVariables.ATLAS_CLIENT_ID,
      clientId,
      StorageLocation.WORKSPACE,
    );
  }
  setClientSecret(clientSecret: string): Promise<void> {
    const clientId = this.getStoredClientId();
    if (!clientId) {
      return Promise.reject(new Error('Client ID is not set'));
    }
    return this._storageController.setSecret(
      'atlasClientSecret_' + clientId,
      clientSecret,
    );
  }
  async clearCredentials(): Promise<void> {
    const clientId = this.getStoredClientId();
    if (!clientId) {
      return;
    }
    await Promise.all([
      this._storageController.update(
        StorageVariables.ATLAS_CLIENT_ID,
        undefined,
      ),
      this._storageController.deleteSecret('atlasClientSecret_' + clientId),
    ]);
  }
}
