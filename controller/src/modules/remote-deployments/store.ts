import type { Database } from "bun:sqlite";
import { Schema, type Effect } from "effect";
import {
  makeDatabaseCloser,
  openInitializedDatabase,
  repositoryEffect,
  type RepositoryError,
} from "../../stores/sqlite";
import { RemoteDeploymentRecordSchema, type RemoteDeploymentRecord } from "./contracts";

type RemoteDeploymentRow = {
  data: string;
};

const decodeRecord = (data: string): RemoteDeploymentRecord =>
  Schema.decodeUnknownSync(RemoteDeploymentRecordSchema)(JSON.parse(data) as unknown);

export class RemoteDeploymentStore {
  private readonly db: Database;
  private readonly closeDatabase: () => Effect.Effect<void, RepositoryError>;

  public constructor(dbPath: string) {
    this.db = openInitializedDatabase(dbPath, (db) => this.ensureSchema(db));
    this.closeDatabase = makeDatabaseCloser(this.db, "remote-deployments.close");
  }

  private ensureSchema(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS remote_deployments (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_instance_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_remote_deployments_status ON remote_deployments(status)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_remote_deployments_instance ON remote_deployments(provider_instance_id)",
    );
  }

  public list(): Effect.Effect<RemoteDeploymentRecord[], RepositoryError> {
    return repositoryEffect("remote-deployments.list", () => {
      const rows = this.db
        .query("SELECT data FROM remote_deployments ORDER BY created_at DESC")
        .all() as RemoteDeploymentRow[];
      return rows.map((row) => decodeRecord(row.data));
    });
  }

  public get(id: string): Effect.Effect<RemoteDeploymentRecord | null, RepositoryError> {
    return repositoryEffect("remote-deployments.get", () => {
      const row = this.db
        .query("SELECT data FROM remote_deployments WHERE id = ?")
        .get(id) as RemoteDeploymentRow | null;
      return row ? decodeRecord(row.data) : null;
    });
  }

  public save(record: RemoteDeploymentRecord): Effect.Effect<void, RepositoryError> {
    return repositoryEffect("remote-deployments.save", () => {
      const data = JSON.stringify(record);
      this.db
        .query(
          `INSERT INTO remote_deployments
             (id, data, status, provider_instance_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             data = excluded.data,
             status = excluded.status,
             provider_instance_id = excluded.provider_instance_id,
             updated_at = excluded.updated_at`,
        )
        .run(
          record.id,
          data,
          record.status,
          record.providerInstanceId,
          record.createdAt,
          record.updatedAt,
        );
    });
  }

  public close(): Effect.Effect<void, RepositoryError> {
    return this.closeDatabase();
  }
}
