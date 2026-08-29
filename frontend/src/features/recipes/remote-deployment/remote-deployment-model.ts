"use client";

import { useCallback, useMemo, useState } from "react";
import api from "@/lib/api/client";
import type {
  RemoteComputeOffer,
  RemoteComputeProviderId,
  RemoteComputeRequirements,
  RemoteDeploymentView,
  RemoteProviderOfferError,
  RemoteProviderStatus,
} from "@/lib/types";
import { useMountSubscription } from "@/hooks/use-mount-subscription";

type ControllerEventDetail = {
  type?: string;
  data?: { deployment?: RemoteDeploymentView };
};

const upsertDeployment = (
  deployments: RemoteDeploymentView[],
  deployment: RemoteDeploymentView,
): RemoteDeploymentView[] =>
  [deployment, ...deployments.filter((candidate) => candidate.id !== deployment.id)].sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
  );

const offerKey = (offer: RemoteComputeOffer): string => `${offer.provider}:${offer.id}`;

export function useRemoteDeploymentModel(recipeId: string) {
  const [providers, setProviders] = useState<RemoteProviderStatus[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<Set<RemoteComputeProviderId>>(
    new Set(),
  );
  const [requirements, setRequirements] = useState<RemoteComputeRequirements | null>(null);
  const [offers, setOffers] = useState<RemoteComputeOffer[]>([]);
  const [providerErrors, setProviderErrors] = useState<RemoteProviderOfferError[]>([]);
  const [deployments, setDeployments] = useState<RemoteDeploymentView[]>([]);
  const [selectedOfferKey, setSelectedOfferKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [destroyingId, setDestroyingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadOffers = useCallback(
    async (ids: RemoteComputeProviderId[]) => {
      if (ids.length === 0) {
        setRequirements(null);
        setOffers([]);
        setProviderErrors([]);
        setSelectedOfferKey(null);
        return;
      }
      const result = await api.getRemoteOffers({ recipe_id: recipeId, providers: ids });
      setRequirements(result.requirements);
      setOffers([...result.offers]);
      setProviderErrors([...result.provider_errors]);
      const compatibleOffer = result.offers.find((offer) => offer.compatible);
      setSelectedOfferKey((current) =>
        result.offers.some((offer) => offerKey(offer) === current && offer.compatible)
          ? current
          : compatibleOffer
            ? offerKey(compatibleOffer)
            : null,
      );
    },
    [recipeId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusResult, deploymentResult] = await Promise.all([
        api.getRemoteProviderStatuses(),
        api.getRemoteDeployments(recipeId),
      ]);
      const configured = statusResult.providers
        .filter((provider) => provider.configured)
        .map((provider) => provider.id);
      setProviders(statusResult.providers);
      setSelectedProviders(new Set(configured));
      setDeployments(deploymentResult.deployments);
      await loadOffers(configured);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load remote compute offers");
    } finally {
      setLoading(false);
    }
  }, [loadOffers, recipeId]);

  useMountSubscription(() => {
    void load();
  }, [load]);

  useMountSubscription(() => {
    const onControllerEvent = (event: Event) => {
      const detail = (event as CustomEvent<ControllerEventDetail>).detail;
      if (detail.type !== "remote_deployment_updated") return;
      const deployment = detail.data?.deployment;
      if (!deployment || deployment.recipe_id !== recipeId) return;
      setDeployments((current) => upsertDeployment(current, deployment));
    };
    window.addEventListener("vllm:controller-event", onControllerEvent);
    return () => window.removeEventListener("vllm:controller-event", onControllerEvent);
  }, [recipeId]);

  const toggleProvider = useCallback((provider: RemoteComputeProviderId, checked: boolean) => {
    setSelectedProviders((current) => {
      const next = new Set(current);
      if (checked) next.add(provider);
      else next.delete(provider);
      return next;
    });
  }, []);

  const refreshOffers = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await loadOffers([...selectedProviders]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh remote compute offers");
    } finally {
      setRefreshing(false);
    }
  }, [loadOffers, selectedProviders]);

  const selectedOffer = useMemo(
    () => offers.find((offer) => offerKey(offer) === selectedOfferKey) ?? null,
    [offers, selectedOfferKey],
  );

  const deploy = useCallback(async () => {
    if (!selectedOffer?.compatible) return;
    setDeploying(true);
    setError(null);
    try {
      const result = await api.createRemoteDeployment({
        recipe_id: recipeId,
        provider: selectedOffer.provider,
        offer_id: selectedOffer.id,
      });
      setDeployments((current) => upsertDeployment(current, result.deployment));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create remote deployment");
    } finally {
      setDeploying(false);
    }
  }, [recipeId, selectedOffer]);

  const destroy = useCallback(async (deploymentId: string) => {
    setDestroyingId(deploymentId);
    setError(null);
    try {
      const result = await api.destroyRemoteDeployment(deploymentId);
      setDeployments((current) => upsertDeployment(current, result.deployment));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not destroy remote deployment");
    } finally {
      setDestroyingId(null);
    }
  }, []);

  return {
    providers,
    selectedProviders,
    requirements,
    offers,
    providerErrors,
    deployments,
    selectedOffer,
    selectedOfferKey,
    loading,
    refreshing,
    deploying,
    destroyingId,
    error,
    setSelectedOfferKey,
    toggleProvider,
    refreshOffers,
    deploy,
    destroy,
  };
}
