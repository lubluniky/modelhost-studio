"use client";

import type { RecipeWithStatus, RemoteComputeOffer, RemoteDeploymentView } from "@/lib/types";
import { Alert, Button, Card, Checkbox, ModelButton, Spinner, StatusPill } from "@/ui";
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader } from "@/ui/drawer";
import { Check, Clock, RefreshCw, Rocket, Trash2 } from "@/ui/icon-registry";
import { cx } from "@/ui/utils";
import { useRemoteDeploymentModel } from "./remote-deployment-model";

const PROVIDER_LABELS = { vast: "Vast.ai", runpod: "RunPod" } as const;
const STAGE_PROGRESS: Record<RemoteDeploymentView["stage"], number> = {
  resolving: 8,
  provisioning: 24,
  bootstrapping: 48,
  starting: 64,
  checking_health: 82,
  ready: 100,
  destroying: 55,
  destroyed: 100,
  error: 100,
  missing: 100,
};

const price = (value: number): string => `$${value.toFixed(value < 1 ? 3 : 2)}/h`;
const memory = (value: number): string =>
  Number.isInteger(value) ? `${value} GB` : `${value.toFixed(1)} GB`;

const deploymentTone = (deployment: RemoteDeploymentView) => {
  if (deployment.status === "ready" && deployment.last_health_status === "healthy") return "good";
  if (deployment.status === "destroyed") return "default";
  if (["failed", "destroy_failed", "missing"].includes(deployment.status)) return "danger";
  return "info";
};

const deploymentRoute = (deployment: RemoteDeploymentView): string | null =>
  deployment.route_model_id
    ? `remote-${deployment.provider}-${deployment.id}/${deployment.route_model_id}`
    : null;

function RequirementsCard({
  requirements,
}: {
  requirements: ReturnType<typeof useRemoteDeploymentModel>["requirements"];
}) {
  if (!requirements) return null;
  return (
    <Card padding="sm" title="Requirements">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[length:var(--fs-sm)] sm:grid-cols-4">
        <div>
          <dt className="text-(--ui-muted)">VRAM</dt>
          <dd className="mt-0.5 font-medium text-(--ui-fg)">
            ≥ {memory(requirements.min_vram_gb)}
          </dd>
        </div>
        <div>
          <dt className="text-(--ui-muted)">GPU</dt>
          <dd className="mt-0.5 font-medium text-(--ui-fg)">{requirements.gpu_count} × NVIDIA</dd>
        </div>
        <div>
          <dt className="text-(--ui-muted)">Weights</dt>
          <dd className="mt-0.5 font-medium text-(--ui-fg)">
            {memory(requirements.weight_size_gb)}
          </dd>
        </div>
        <div>
          <dt className="text-(--ui-muted)">Context</dt>
          <dd className="mt-0.5 font-medium text-(--ui-fg)">
            {requirements.context_length.toLocaleString()}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function DeploymentCard({
  deployment,
  destroying,
  onDestroy,
}: {
  deployment: RemoteDeploymentView;
  destroying: boolean;
  onDestroy: () => void;
}) {
  const route = deploymentRoute(deployment);
  const destroyable = !["destroyed", "destroying", "failed", "missing"].includes(deployment.status);
  return (
    <Card padding="sm" className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusPill tone={deploymentTone(deployment)} variant="badge">
              {deployment.status.replaceAll("_", " ")}
            </StatusPill>
            <span className="text-[length:var(--fs-sm)] font-medium text-(--ui-fg)">
              {PROVIDER_LABELS[deployment.provider]} · {deployment.offer.gpu_name}
            </span>
          </div>
          <p className="mt-2 text-[length:var(--fs-sm)] text-(--ui-muted)">{deployment.message}</p>
        </div>
        {destroyable ? (
          <ModelButton tone="danger" onClick={onDestroy} disabled={destroying}>
            {destroying ? <Spinner size="xs" /> : <Trash2 className="h-3 w-3" />}
            Destroy
          </ModelButton>
        ) : null}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-(--ui-fg)/10">
        <div
          className={cx(
            "h-full rounded-full transition-[width] duration-500",
            deployment.status === "ready" ? "bg-(--ui-success)" : "bg-(--ui-info)",
          )}
          style={{ width: `${STAGE_PROGRESS[deployment.stage]}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--fs-xs)] text-(--ui-muted)">
        <span>{price(deployment.offer.hourly_price)}</span>
        <span>{deployment.stage.replaceAll("_", " ")}</span>
        {route ? (
          <span className="truncate" title={route}>
            Route: {route}
          </span>
        ) : null}
      </div>
      {deployment.error ? <Alert variant="error">{deployment.error}</Alert> : null}
    </Card>
  );
}

function OfferRow({
  offer,
  selected,
  onSelect,
}: {
  offer: RemoteComputeOffer;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!offer.compatible}
      onClick={onSelect}
      className={cx(
        "grid w-full grid-cols-[minmax(0,1.4fr)_0.65fr_0.7fr_0.7fr] items-center gap-3 border-b border-(--ui-separator) px-3 py-2.5 text-left text-[length:var(--fs-sm)] last:border-b-0",
        offer.compatible ? "hover:bg-(--ui-hover)" : "cursor-not-allowed opacity-45",
        selected && "bg-(--ui-info)/8",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cx(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
            selected ? "border-(--ui-info) bg-(--ui-info) text-white" : "border-(--ui-border)",
          )}
        >
          {selected ? <Check className="h-2.5 w-2.5" /> : null}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-(--ui-fg)">{offer.gpu_name}</span>
          <span className="block truncate text-[length:var(--fs-xs)] text-(--ui-muted)">
            {PROVIDER_LABELS[offer.provider]} · {offer.region ?? "region assigned at provision"}
          </span>
        </span>
      </span>
      <span>{memory(offer.gpu_memory_gb)}</span>
      <span>{offer.compatible ? "Fits" : "Does not fit"}</span>
      <span className="text-right font-medium text-(--ui-fg)">{price(offer.hourly_price)}</span>
    </button>
  );
}

export function RemoteDeploymentDrawer({
  recipe,
  onClose,
}: {
  recipe: RecipeWithStatus;
  onClose: () => void;
}) {
  const model = useRemoteDeploymentModel(recipe.id);
  const configuredCount = model.providers.filter((provider) => provider.configured).length;
  const environmentVariableCount = Object.keys(recipe.env_vars ?? {}).length;

  return (
    <Drawer width={840}>
      <DrawerHeader
        title={`Deploy remote · ${recipe.name}`}
        icon={<Rocket className="h-3.5 w-3.5 text-(--ui-info)" />}
        onClose={onClose}
      />
      <DrawerBody className="space-y-4">
        <div>
          <h3 className="text-[length:var(--fs-sm)] font-medium text-(--ui-fg)">Providers</h3>
          <div className="mt-2 flex flex-wrap gap-5">
            {model.providers.map((provider) => (
              <Checkbox
                key={provider.id}
                label={PROVIDER_LABELS[provider.id]}
                description={
                  provider.configured ? "Credential configured" : "Controller credential missing"
                }
                checked={model.selectedProviders.has(provider.id)}
                disabled={!provider.configured}
                onChange={(checked) => model.toggleProvider(provider.id, checked)}
              />
            ))}
            <ModelButton
              onClick={() => void model.refreshOffers()}
              disabled={model.refreshing || model.selectedProviders.size === 0}
            >
              {model.refreshing ? <Spinner size="xs" /> : <RefreshCw className="h-3 w-3" />}
              Refresh offers
            </ModelButton>
          </div>
        </div>

        {configuredCount === 0 && !model.loading ? (
          <Alert variant="warning">
            Configure <code>LOCAL_STUDIO_VAST_API_KEY</code> or{" "}
            <code>LOCAL_STUDIO_RUNPOD_API_KEY</code> on the controller and restart it.
          </Alert>
        ) : null}
        {environmentVariableCount > 0 ? (
          <Alert variant="warning">
            This recipe sends {environmentVariableCount} environment{" "}
            {environmentVariableCount === 1 ? "variable" : "variables"} to the selected provider.
            Values are never shown here.
          </Alert>
        ) : null}
        {model.error ? <Alert variant="error">{model.error}</Alert> : null}
        {model.providerErrors.map((providerError) => (
          <Alert key={providerError.provider} variant="warning">
            {PROVIDER_LABELS[providerError.provider]}: {providerError.message}
          </Alert>
        ))}

        {model.deployments.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-[length:var(--fs-sm)] font-medium text-(--ui-fg)">Deployments</h3>
            {model.deployments.map((deployment) => (
              <DeploymentCard
                key={deployment.id}
                deployment={deployment}
                destroying={model.destroyingId === deployment.id}
                onDestroy={() => void model.destroy(deployment.id)}
              />
            ))}
          </section>
        ) : null}

        <RequirementsCard requirements={model.requirements} />

        <section>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[length:var(--fs-sm)] font-medium text-(--ui-fg)">Offers</h3>
            <span className="text-[length:var(--fs-xs)] text-(--ui-muted)">
              {model.offers.filter((offer) => offer.compatible).length} compatible
            </span>
          </div>
          <div className="mt-2 overflow-hidden rounded-[var(--rad-lg)] border border-(--ui-border) bg-(--ui-surface)">
            <div className="grid grid-cols-[minmax(0,1.4fr)_0.65fr_0.7fr_0.7fr] gap-3 border-b border-(--ui-separator) px-3 py-2 text-[length:var(--fs-xs)] text-(--ui-muted)">
              <span>GPU</span>
              <span>VRAM</span>
              <span>Fit</span>
              <span className="text-right">Price</span>
            </div>
            {model.loading ? (
              <div className="flex items-center justify-center gap-2 px-3 py-10 text-[length:var(--fs-sm)] text-(--ui-muted)">
                <Spinner size="sm" /> Loading current offers…
              </div>
            ) : model.offers.length === 0 ? (
              <div className="px-3 py-10 text-center text-[length:var(--fs-sm)] text-(--ui-muted)">
                No offers returned for the selected providers.
              </div>
            ) : (
              model.offers.map((offer) => (
                <OfferRow
                  key={`${offer.provider}:${offer.id}`}
                  offer={offer}
                  selected={model.selectedOfferKey === `${offer.provider}:${offer.id}`}
                  onSelect={() => model.setSelectedOfferKey(`${offer.provider}:${offer.id}`)}
                />
              ))
            )}
          </div>
        </section>
      </DrawerBody>
      <DrawerFooter
        status={
          model.selectedOffer ? (
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3 w-3" /> {PROVIDER_LABELS[model.selectedOffer.provider]} ·{" "}
              {price(model.selectedOffer.hourly_price)} until destroyed
            </span>
          ) : (
            "Select a compatible offer"
          )
        }
      >
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button
          size="sm"
          onClick={() => void model.deploy()}
          disabled={!model.selectedOffer?.compatible || model.deploying}
          loading={model.deploying}
          icon={<Rocket className="h-3.5 w-3.5" />}
        >
          Deploy
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
