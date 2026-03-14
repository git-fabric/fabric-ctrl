/**
 * invoke/index.ts — fabric-invoke orchestration engine
 *
 * Routes queries through fabric-router, dispatches to specialist Ollama models,
 * chains context between steps, and manages AIANA recall/record on both ends.
 */

import { routeQuery } from "./router.js";
import { callModel, buildChainedPrompt, listLoadedModels, getOllamaEndpoint } from "./dispatcher.js";
import { recallContext, recordOutcome, isAianaReachable, getAianaEndpoint, hasMemoryLanguage } from "./aiana.js";
import { SEQUENCES } from "./sequences.js";
import type {
  InvokeRequest,
  InvokeResponse,
  DryRunResponse,
  StatusResponse,
  Step,
} from "./types.js";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:7340";

/**
 * Handle a full /invoke request — route, dispatch, chain, record.
 */
export async function handleInvoke(
  req: InvokeRequest,
): Promise<InvokeResponse | DryRunResponse> {
  const totalStart = Date.now();
  const shouldRecord = req.record !== false;

  // Step 1: Route the query through fabric-router
  const { decision, duration_ms: routeDuration } = await routeQuery(
    req.query,
    req.context,
  );

  console.log(
    `[invoke:route] ${decision.primary}` +
      (decision.sequence ? ` → ${decision.sequence}` : "") +
      ` (${routeDuration}ms)`,
  );

  // Dry run — return route metadata only
  if (req.dry_run) {
    const { context_pass: _, ...route } = decision;
    return { route, dry_run: true };
  }

  const steps: Step[] = [];
  const priorOutputs: Array<{ agent: string; output: string }> = [];
  let stepNum = 0;

  // Determine execution plan: sequence or single specialist
  const sequence = decision.sequence ? SEQUENCES[decision.sequence] : null;

  // AIANA recall: if memory language detected OR sequence starts with recall
  const needsRecall =
    hasMemoryLanguage(req.query) ||
    (sequence?.steps[0]?.type === "recall");

  if (needsRecall && !(sequence?.steps[0]?.type === "recall")) {
    // Inject a recall step before the sequence/specialist
    stepNum++;
    const { output, duration_ms } = await recallContext(req.query, req.project);
    steps.push({ step: stepNum, agent: "aiana-ops", type: "recall", output, duration_ms });
    if (output) priorOutputs.push({ agent: "aiana-ops", output });
  }

  if (sequence) {
    // Execute the defined sequence
    for (const seqStep of sequence.steps) {
      // Skip conditional steps for now (Phase 1 — no conditional evaluation logic)
      if (seqStep.conditional) continue;

      stepNum++;

      if (seqStep.type === "recall") {
        const { output, duration_ms } = await recallContext(req.query, req.project);
        steps.push({ step: stepNum, agent: seqStep.agent, type: "recall", output, duration_ms });
        if (output) priorOutputs.push({ agent: seqStep.agent, output });
      } else if (seqStep.type === "record") {
        // Record happens at the end — skip for now, handled below
        continue;
      } else {
        // Specialist dispatch
        const prompt = priorOutputs.length > 0
          ? buildChainedPrompt(priorOutputs, req.query, req.context)
          : req.context
            ? `${req.context}\n\n${req.query}`
            : req.query;

        try {
          const { response, duration_ms } = await callModel(seqStep.agent, prompt);
          steps.push({
            step: stepNum,
            agent: seqStep.agent,
            type: "specialist",
            output: response,
            duration_ms,
          });
          priorOutputs.push({ agent: seqStep.agent, output: response });
        } catch (err) {
          const duration_ms = 0;
          const output = `${seqStep.agent} failed: ${err instanceof Error ? err.message : String(err)}`;
          steps.push({ step: stepNum, agent: seqStep.agent, type: "specialist", output, duration_ms });
          console.warn(`[invoke:dispatch] ${output}`);
        }
      }
    }
  } else {
    // Single specialist — primary only
    stepNum++;
    const prompt = priorOutputs.length > 0
      ? buildChainedPrompt(priorOutputs, req.query, req.context)
      : req.context
        ? `${req.context}\n\n${req.query}`
        : req.query;

    try {
      const { response, duration_ms } = await callModel(decision.primary, prompt);
      steps.push({
        step: stepNum,
        agent: decision.primary,
        type: "specialist",
        output: response,
        duration_ms,
      });
      priorOutputs.push({ agent: decision.primary, output: response });
    } catch (err) {
      const output = `${decision.primary} failed: ${err instanceof Error ? err.message : String(err)}`;
      steps.push({ step: stepNum, agent: decision.primary, type: "specialist", output, duration_ms: 0 });
    }

    // Execute secondary agents if any
    for (const sec of decision.secondary) {
      stepNum++;
      const secPrompt = buildChainedPrompt(priorOutputs, req.query, req.context);
      try {
        const { response, duration_ms } = await callModel(sec, secPrompt);
        steps.push({ step: stepNum, agent: sec, type: "specialist", output: response, duration_ms });
        priorOutputs.push({ agent: sec, output: response });
      } catch (err) {
        const output = `${sec} failed: ${err instanceof Error ? err.message : String(err)}`;
        steps.push({ step: stepNum, agent: sec, type: "specialist", output, duration_ms: 0 });
      }
    }
  }

  // Aggregate result from all specialist outputs
  const specialistOutputs = steps
    .filter((s) => s.type === "specialist" || s.type === "recall")
    .map((s) => s.output);
  const result = specialistOutputs.join("\n\n");

  // AIANA record
  let aiana_memory_id: string | undefined;
  if (shouldRecord) {
    stepNum++;
    const tags = [
      decision.primary,
      ...(decision.sequence ? [decision.sequence] : []),
      ...(req.project ? [req.project] : []),
    ];
    const recordResult = await recordOutcome(result, req.project, tags);
    aiana_memory_id = recordResult.memory_id;
    steps.push({
      step: stepNum,
      agent: "aiana-ops",
      type: "record",
      output: aiana_memory_id ? `Recorded: ${aiana_memory_id}` : "Recorded (no ID returned)",
      duration_ms: recordResult.duration_ms,
    });
  }

  const { context_pass: _, ...route } = decision;

  return {
    route,
    steps,
    result,
    aiana_memory_id,
    total_duration_ms: Date.now() - totalStart,
  };
}

/**
 * Health/status check — which models are loaded, are dependencies reachable?
 */
export async function handleStatus(): Promise<StatusResponse> {
  const [models, aianaUp, gatewayUp] = await Promise.all([
    listLoadedModels().catch(() => [] as string[]),
    isAianaReachable(),
    fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok)
      .catch(() => false),
  ]);

  const ollamaUp = models.length > 0;
  const status = !ollamaUp
    ? "unhealthy"
    : !aianaUp
      ? "degraded"
      : "healthy";

  return {
    ollama: { endpoint: getOllamaEndpoint(), loaded_models: models },
    aiana: { reachable: aianaUp, endpoint: getAianaEndpoint() },
    gateway: { reachable: gatewayUp, endpoint: GATEWAY_URL },
    sequences: Object.keys(SEQUENCES),
    status,
  };
}
