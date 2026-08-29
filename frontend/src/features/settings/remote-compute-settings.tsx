"use client";

import { useCallback, useMemo, useState } from "react";
import type {
  RemoteDeploymentCredentialId,
  RemoteDeploymentCredentialStatus,
  RemoteDeploymentCredentialUpdate,
} from "@/lib/types";
import { useMountSubscription } from "@/hooks/use-mount-subscription";
import api from "@/lib/api/client";
import { Spinner, StatusPill } from "@/ui";
import {
  SettingsButton,
  SettingsGroup,
  SettingsInput,
  SettingsNotice,
  SettingsRow,
} from "./settings-ui";

type CredentialDefinition = {
  id: RemoteDeploymentCredentialId;
  label: string;
  description: string;
  placeholder: string;
  payload: (value: string | null) => RemoteDeploymentCredentialUpdate;
};

const CREDENTIALS: CredentialDefinition[] = [
  {
    id: "vast",
    label: "Vast.ai API key",
    description: "Used to browse offers and manage Vast.ai instances.",
    placeholder: "Paste Vast.ai API key",
    payload: (value) => ({ vast_api_key: value }),
  },
  {
    id: "runpod",
    label: "RunPod API key",
    description: "Used to browse GPU stock and manage RunPod Pods.",
    placeholder: "Paste RunPod API key",
    payload: (value) => ({ runpod_api_key: value }),
  },
  {
    id: "huggingface",
    label: "Hugging Face token",
    description: "Optional. Required only for private or gated model repositories.",
    placeholder: "Paste Hugging Face token",
    payload: (value) => ({ huggingface_token: value }),
  },
];

const statusLabel = (status: RemoteDeploymentCredentialStatus | undefined): string => {
  if (status?.source === "settings") return "Saved in Settings";
  if (status?.source === "environment") return "From environment";
  return "Not configured";
};

export function RemoteComputeSettings() {
  const [statuses, setStatuses] = useState<RemoteDeploymentCredentialStatus[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<RemoteDeploymentCredentialId, string>>>({});
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<RemoteDeploymentCredentialId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const byId = useMemo(() => new Map(statuses.map((status) => [status.id, status])), [statuses]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getRemoteDeploymentCredentialStatuses();
      setStatuses(result.credentials);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load remote credentials");
    } finally {
      setLoading(false);
    }
  }, []);

  useMountSubscription(() => {
    void load();
  }, [load]);

  const apply = useCallback(async (definition: CredentialDefinition, value: string | null) => {
    setActiveId(definition.id);
    setError(null);
    setMessage(null);
    try {
      const result = await api.updateRemoteDeploymentCredentials(definition.payload(value));
      setStatuses(result.credentials);
      setDrafts((current) => ({ ...current, [definition.id]: "" }));
      setMessage(value === null ? `${definition.label} removed` : `${definition.label} saved`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save remote credentials");
    } finally {
      setActiveId(null);
    }
  }, []);

  return (
    <div className="space-y-4">
      <SettingsNotice>
        Keys stay in the controller database and are never returned to this page. Environment
        variables remain available as a fallback.
      </SettingsNotice>
      {error ? <SettingsNotice tone="danger">{error}</SettingsNotice> : null}
      {message ? <SettingsNotice tone="good">{message}</SettingsNotice> : null}
      <SettingsGroup
        title="Remote GPU credentials"
        description="Add or rotate credentials without restarting the controller."
      >
        {CREDENTIALS.map((definition) => {
          const status = byId.get(definition.id);
          const value = drafts[definition.id] ?? "";
          const pending = activeId === definition.id;
          return (
            <SettingsRow
              key={definition.id}
              label={definition.label}
              description={definition.description}
              control={
                <SettingsInput
                  type="password"
                  autoComplete="new-password"
                  value={value}
                  placeholder={
                    status?.configured ? "Enter a new value to replace" : definition.placeholder
                  }
                  aria-label={definition.label}
                  onChange={(next) =>
                    setDrafts((current) => ({ ...current, [definition.id]: next }))
                  }
                />
              }
              status={
                loading ? (
                  <Spinner size="xs" />
                ) : (
                  <StatusPill tone={status?.configured ? "good" : "default"}>
                    {statusLabel(status)}
                  </StatusPill>
                )
              }
              actions={
                <>
                  <SettingsButton
                    tone="primary"
                    disabled={pending || value.trim().length === 0}
                    onClick={() => void apply(definition, value)}
                  >
                    {pending ? <Spinner size="xs" /> : null}
                    Save
                  </SettingsButton>
                  {status?.source === "settings" ? (
                    <SettingsButton
                      tone="danger"
                      disabled={pending}
                      onClick={() => void apply(definition, null)}
                    >
                      Remove
                    </SettingsButton>
                  ) : null}
                </>
              }
            />
          );
        })}
      </SettingsGroup>
    </div>
  );
}
