// src/agent-panel.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, Link2, Loader2, RefreshCw, Sparkles, Square, Unplug } from "lucide-react";

// src/api.ts
var RequestError = class extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
  status;
  code;
};
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: { ...options.body ? { "Content-Type": "application/json" } : {}, ...options.headers }
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
  }
  if (!response.ok) {
    if (response.status === 401 && payload?.code === "SIGN_IN_REQUIRED") window.dispatchEvent(new Event("corner:session-expired"));
    throw new RequestError(typeof payload?.error === "string" ? payload.error : payload?.error?.message || payload?.message || "The request could not be completed. Please try again.", response.status, payload?.code);
  }
  return payload;
}
var post = (path, body, signal) => api(path, { method: "POST", body: JSON.stringify(body), signal });
var errorMessage = (error) => error instanceof Error ? error.message : "Something went wrong. Please try again.";

// src/agent-panel.tsx
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var number = (value) => value.toLocaleString(void 0, { maximumFractionDigits: 1 });
var when = (value) => new Date(value).toLocaleString(void 0, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
var isActive = (run) => run.status === "running";
function latestRun(current, incoming) {
  if (!current) return incoming;
  if (current.status === "applied" && incoming.status !== "applied") return current;
  if (current.status !== "running" && incoming.status === "running") return current;
  return incoming.updatedAt >= current.updatedAt ? incoming : current;
}
function AgentConnection({ onChanged, compact = false }) {
  const [connection, setConnection] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionNotice, setActionNotice] = useState(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await api("/api/ai/connection");
      if (current === sequence.current) {
        setConnection(result);
        onChangedRef.current?.();
      }
    } catch (failure) {
      if (current === sequence.current) setError(errorMessage(failure));
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current += 1;
    };
  }, [refresh]);
  async function connect() {
    if (busy) return;
    const current = sequence.current;
    setBusy(true);
    setError("");
    setActionNotice(null);
    try {
      const result = await post("/api/ai/connect", {});
      if (current !== sequence.current) return;
      const destination = new URL(result.url, window.location.origin);
      if (!["https:", "http:"].includes(destination.protocol)) throw new Error("The sign-in link is unavailable. Please try again.");
      window.location.assign(destination.href);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }
  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await post("/api/ai/disconnect", {});
      await refresh();
      setActionNotice({ warning: result?.revocationConfirmed === false, message: result?.reason || (result?.revocationConfirmed === false ? "The local connection was removed, but remote access revocation could not be confirmed. You can manage the connection in your ChatGPT settings." : "Your AI connection was removed.") });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function changeModel(model) {
    if (!model || busy) return;
    setBusy(true);
    setError("");
    try {
      await post("/api/ai/model", { model });
      await refresh();
      setActionNotice({ message: "Model selection saved.", warning: false });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const ready = Boolean(connection?.available && connection.connected && connection.enabled);
  const reconnect = Boolean(connection?.connected && connection.enabled && !ready);
  return /* @__PURE__ */ jsxs("section", { className: `agent-connection ${compact ? "agent-connection-compact" : ""}`, "aria-label": "Agent connection", children: [
    /* @__PURE__ */ jsxs("div", { className: "agent-connection-heading", children: [
      /* @__PURE__ */ jsxs("span", { children: [
        /* @__PURE__ */ jsx(Link2, { size: 18 }),
        "Your AI connection"
      ] }),
      /* @__PURE__ */ jsx("button", { className: "icon-button", type: "button", "aria-label": "Refresh AI connection", disabled: loading || busy, onClick: () => void refresh(), children: /* @__PURE__ */ jsx(RefreshCw, { size: 16, className: loading ? "spin" : "" }) })
    ] }),
    /* @__PURE__ */ jsx("p", { className: "agent-connection-status", role: "status", children: loading ? "Checking connection\u2026" : ready ? "Connected and ready" : connection?.connected ? "Connected \xB7 action needed" : connection?.enabled ? "Connect to use the agent" : "Agent unavailable" }),
    connection?.email && /* @__PURE__ */ jsx("p", { className: "agent-account-email", children: connection.email }),
    /* @__PURE__ */ jsx("p", { children: connection?.reason || (ready ? "Requests use your selected connection. Review proposed changes before applying them." : "Your plans and tracking work independently. Connect when you want help creating or adapting a plan.") }),
    connection && connection.models.length > 0 && /* @__PURE__ */ jsxs("label", { className: "field", children: [
      /* @__PURE__ */ jsx("span", { children: "Model" }),
      /* @__PURE__ */ jsxs("select", { disabled: busy || loading || !connection.connected, value: connection.model ?? "", onChange: (event) => void changeModel(event.target.value), children: [
        /* @__PURE__ */ jsx("option", { value: "", disabled: true, children: "Choose a model" }),
        connection.models.map((model) => /* @__PURE__ */ jsx("option", { value: model.slug, children: model.displayName }, model.slug))
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "button-row", children: [
      (!connection?.connected || reconnect) && /* @__PURE__ */ jsxs("button", { type: "button", className: "button primary", disabled: busy || loading || !connection?.enabled, onClick: () => void connect(), children: [
        busy ? /* @__PURE__ */ jsx(Loader2, { size: 16, className: "spin" }) : /* @__PURE__ */ jsx(Link2, { size: 16 }),
        busy ? "Opening sign-in\u2026" : reconnect ? "Reconnect with ChatGPT" : "Continue with ChatGPT"
      ] }),
      connection?.connected && /* @__PURE__ */ jsxs("button", { type: "button", className: "button outline small", disabled: busy || loading, onClick: () => void disconnect(), children: [
        busy ? /* @__PURE__ */ jsx(Loader2, { size: 15, className: "spin" }) : /* @__PURE__ */ jsx(Unplug, { size: 15 }),
        "Disconnect"
      ] })
    ] }),
    connection?.enabled && /* @__PURE__ */ jsx("p", { className: "agent-connection-help", children: "After linking an account, reconnecting uses the same ChatGPT identity." }),
    connection?.manageUsageUrl && /^https:\/\//.test(connection.manageUsageUrl) && /* @__PURE__ */ jsxs("a", { className: "text-link inline-link", href: connection.manageUsageUrl, target: "_blank", rel: "noopener noreferrer", children: [
      "Manage AI usage ",
      /* @__PURE__ */ jsx(ArrowRight, { size: 14 })
    ] }),
    error && /* @__PURE__ */ jsx("p", { className: "form-error", role: "alert", children: error }),
    actionNotice && /* @__PURE__ */ jsxs("p", { className: `agent-action-notice ${actionNotice.warning ? "is-warning" : ""}`, role: "status", children: [
      actionNotice.message,
      actionNotice.warning && /* @__PURE__ */ jsxs("a", { href: "https://chatgpt.com/#settings", target: "_blank", rel: "noopener noreferrer", children: [
        "Open ChatGPT settings ",
        /* @__PURE__ */ jsx(ArrowRight, { size: 13 })
      ] })
    ] })
  ] });
}
function Nutrition({ value, label }) {
  return /* @__PURE__ */ jsxs("div", { className: "agent-nutrition", children: [
    label && /* @__PURE__ */ jsx("h5", { children: label }),
    /* @__PURE__ */ jsx("dl", { children: ["calories", "protein", "carbs", "fat"].map((key) => /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("dt", { children: key === "calories" ? "Calories" : key.charAt(0).toUpperCase() + key.slice(1) }),
      /* @__PURE__ */ jsxs("dd", { children: [
        number(value[key]),
        /* @__PURE__ */ jsx("span", { children: key === "calories" ? "kcal" : "g" })
      ] })
    ] }, key)) })
  ] });
}
function ExerciseList({ exercises, unit }) {
  return /* @__PURE__ */ jsx("ol", { className: "agent-exercises", children: exercises.map((exercise) => /* @__PURE__ */ jsxs("li", { children: [
    /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("b", { children: exercise.name }),
      /* @__PURE__ */ jsxs("span", { children: [
        exercise.targetSets,
        " sets \xD7 ",
        exercise.repMin === exercise.repMax ? exercise.repMin : `${exercise.repMin}\u2013${exercise.repMax}`,
        " reps",
        exercise.targetRir !== null ? ` \xB7 ${exercise.targetRir} RIR` : " \xB7 RIR not set",
        " \xB7 ",
        exercise.restSeconds,
        "s rest"
      ] }),
      /* @__PURE__ */ jsxs("small", { children: [
        exercise.loadType === "per_hand" ? "Load per hand" : exercise.loadType === "bodyweight" ? "Bodyweight" : exercise.loadType === "assistance" ? "Assistance load" : "Total load",
        exercise.targetLoad ? ` \xB7 ${number(exercise.targetLoad.weight)} ${exercise.targetLoad.unit}` : unit ? ` \xB7 ${unit}, load not set` : ""
      ] })
    ] }),
    exercise.notes && /* @__PURE__ */ jsx("p", { children: exercise.notes })
  ] }, exercise.id)) });
}
function WorkoutPreview({ workout }) {
  const session = "date" in workout;
  return /* @__PURE__ */ jsxs("div", { className: "agent-workout-preview", children: [
    /* @__PURE__ */ jsx("h4", { children: workout.name }),
    /* @__PURE__ */ jsxs("p", { children: [
      session ? `${workout.date} \xB7 ` : "Reusable routine \xB7 ",
      workout.kind,
      " \xB7 ",
      session ? workout.plannedMinutes : workout.durationMinutes,
      " minutes"
    ] }),
    workout.exercises.length > 0 && /* @__PURE__ */ jsx(ExerciseList, { exercises: workout.exercises, unit: session ? workout.unit : void 0 }),
    session ? workout.notes && /* @__PURE__ */ jsx("p", { className: "agent-detail-text", children: workout.notes }) : workout.description && /* @__PURE__ */ jsx("p", { className: "agent-detail-text", children: workout.description })
  ] });
}
function ChangePreview({ change, state, recipes }) {
  let body;
  if (change.type === "recipe") {
    const recipe = change.data;
    const previous = state.recipes.find((item) => item.id === recipe.id);
    body = /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("h4", { children: recipe.name }),
      /* @__PURE__ */ jsx("p", { children: recipe.description }),
      previous && /* @__PURE__ */ jsx(Nutrition, { value: previous.nutrition, label: "Current \xB7 per serving" }),
      /* @__PURE__ */ jsx(Nutrition, { value: recipe.nutrition, label: "Proposed \xB7 per serving" }),
      /* @__PURE__ */ jsxs("p", { children: [
        recipe.prepMinutes,
        " min prep \xB7 ",
        recipe.cookMinutes,
        " min cook \xB7 ",
        recipe.category
      ] }),
      /* @__PURE__ */ jsxs("details", { className: "agent-recipe-details", children: [
        /* @__PURE__ */ jsxs("summary", { children: [
          "Ingredients, steps & storage ",
          /* @__PURE__ */ jsx(ChevronDown, { size: 15 })
        ] }),
        /* @__PURE__ */ jsx("ul", { children: recipe.ingredients.map((ingredient, index) => /* @__PURE__ */ jsxs("li", { children: [
          /* @__PURE__ */ jsx("b", { children: ingredient.display || `${number(ingredient.quantity)} ${ingredient.unit}` }),
          " ",
          ingredient.name,
          ingredient.note && /* @__PURE__ */ jsxs("small", { children: [
            " \u2014 ",
            ingredient.note
          ] }),
          ingredient.optional && /* @__PURE__ */ jsx("small", { children: " \xB7 optional" })
        ] }, index)) }),
        /* @__PURE__ */ jsx("ol", { children: recipe.steps.map((step, index) => /* @__PURE__ */ jsx("li", { children: step }, index)) }),
        recipe.storage && /* @__PURE__ */ jsxs("p", { children: [
          /* @__PURE__ */ jsx("b", { children: "Storage:" }),
          " ",
          recipe.storage
        ] }),
        recipe.variation && /* @__PURE__ */ jsxs("p", { children: [
          /* @__PURE__ */ jsx("b", { children: "Variation:" }),
          " ",
          recipe.variation
        ] })
      ] })
    ] });
  } else if (change.type === "meal") {
    const meal = change.data, recipe = recipes.get(meal.recipeId), previous = state.plan.find((item) => item.id === meal.id);
    body = /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("h4", { children: recipe?.name || "Recipe from this proposal" }),
      previous && /* @__PURE__ */ jsxs("p", { className: "agent-previous", children: [
        "Current: ",
        state.recipes.find((item) => item.id === previous.recipeId)?.name || "Saved recipe",
        " \xB7 ",
        previous.date,
        " \xB7 ",
        previous.slot,
        " \xB7 ",
        number(previous.servings),
        " servings"
      ] }),
      /* @__PURE__ */ jsxs("p", { children: [
        /* @__PURE__ */ jsxs("b", { children: [
          meal.date,
          " \xB7 ",
          meal.slot
        ] }),
        " \xB7 ",
        number(meal.servings),
        " servings"
      ] }),
      recipe && /* @__PURE__ */ jsx(Nutrition, { value: { calories: recipe.nutrition.calories * meal.servings, protein: recipe.nutrition.protein * meal.servings, carbs: recipe.nutrition.carbs * meal.servings, fat: recipe.nutrition.fat * meal.servings }, label: "Planned nutrition" })
    ] });
  } else if (change.type === "workout" || change.type === "routine") {
    const previous = change.type === "workout" ? state.training.sessions.find((item) => item.id === change.data.id) : state.training.templates.find((item) => item.id === change.data.id);
    body = /* @__PURE__ */ jsxs(Fragment, { children: [
      previous && /* @__PURE__ */ jsxs("details", { className: "agent-previous", children: [
        /* @__PURE__ */ jsxs("summary", { children: [
          "Compare with current ",
          change.type
        ] }),
        /* @__PURE__ */ jsx(WorkoutPreview, { workout: previous })
      ] }),
      /* @__PURE__ */ jsx(WorkoutPreview, { workout: change.data })
    ] });
  } else if (change.type === "targets") {
    body = /* @__PURE__ */ jsxs("div", { className: "agent-target-comparison", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("h4", { children: "Training days" }),
        /* @__PURE__ */ jsx(Nutrition, { value: state.settings.training, label: "Current" }),
        /* @__PURE__ */ jsx(Nutrition, { value: change.data.training, label: "Proposed" })
      ] }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("h4", { children: "Recovery days" }),
        /* @__PURE__ */ jsx(Nutrition, { value: state.settings.rest, label: "Current" }),
        /* @__PURE__ */ jsx(Nutrition, { value: change.data.rest, label: "Proposed" })
      ] })
    ] });
  } else if (change.type === "remove_meal") {
    const meal = state.plan.find((item) => item.id === change.data.id);
    body = /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("h4", { children: "Remove a planned meal" }),
      /* @__PURE__ */ jsx("p", { children: meal ? `${recipes.get(meal.recipeId)?.name || meal.recipeId} \xB7 ${meal.date} \xB7 ${meal.slot} \xB7 ${number(meal.servings)} servings` : "This planned meal is no longer in the workspace." })
    ] });
  } else {
    const workout = state.training.sessions.find((item) => item.id === change.data.id);
    body = /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("h4", { children: "Remove a planned workout" }),
      workout ? /* @__PURE__ */ jsx(WorkoutPreview, { workout }) : /* @__PURE__ */ jsx("p", { children: "This planned workout is no longer in the workspace." })
    ] });
  }
  return /* @__PURE__ */ jsxs("article", { className: "agent-change", children: [
    /* @__PURE__ */ jsxs("div", { className: "agent-change-heading", children: [
      /* @__PURE__ */ jsx("span", { children: change.type.replaceAll("_", " ") }),
      /* @__PURE__ */ jsx("h3", { children: change.label }),
      /* @__PURE__ */ jsx("p", { children: change.reason })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "agent-change-content", children: body })
  ] });
}
function AgentPanel({ state, revision, referenceDate, initialPrompt = "", onApplied, onRefresh }) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [date, setDate] = useState(referenceDate);
  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState(null);
  const textarea = useRef(null);
  const operation = useRef(false);
  const intent = useRef(null);
  const appliedIntent = useRef(/* @__PURE__ */ new Map());
  const active = useRef(true);
  const refreshSequence = useRef(0);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const ready = Boolean(connection?.available && connection.connected && connection.enabled);
  const refresh = useCallback(async () => {
    if (!active.current) return;
    const sequence = ++refreshSequence.current;
    setLoading(true);
    setError("");
    try {
      const [history, currentConnection] = await Promise.all([api("/api/agent/runs"), api("/api/ai/connection")]);
      if (!active.current || sequence !== refreshSequence.current) return;
      setRuns((current) => history.runs.map((run) => latestRun(current.find((item) => item.id === run.id), run)));
      setConnection(currentConnection);
    } catch (failure) {
      if (active.current && sequence === refreshSequence.current) setError(errorMessage(failure));
    } finally {
      if (active.current && sequence === refreshSequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      refreshSequence.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    if (initialPrompt) {
      setPrompt(initialPrompt);
      intent.current = null;
      textarea.current?.focus();
    }
  }, [initialPrompt]);
  const runningIds = runs.filter(isActive).map((run) => run.id).join("|");
  useEffect(() => {
    if (!runningIds) return;
    let pending = false;
    const controller = new AbortController();
    const timer = window.setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const updated = await Promise.all(runningIds.split("|").map((id) => api(`/api/agent/runs/${encodeURIComponent(id)}`, { signal: controller.signal })));
        if (!controller.signal.aborted) setRuns((current) => current.map((run) => {
          const incoming = updated.find((item) => item.run.id === run.id)?.run;
          return incoming ? latestRun(run, incoming) : run;
        }));
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      } finally {
        pending = false;
      }
    }, 2e3);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [runningIds]);
  async function start(event) {
    event.preventDefault();
    if (operation.current || !ready || prompt.trim().length < 3) return;
    operation.current = true;
    setBusy(true);
    setError("");
    const signature = JSON.stringify([prompt.trim(), date]);
    if (intent.current?.signature !== signature) intent.current = { signature, id: crypto.randomUUID() };
    try {
      const result = await post("/api/agent/runs", { requestId: intent.current.id, prompt: prompt.trim(), referenceDate: date });
      if (!active.current) return;
      refreshSequence.current += 1;
      setLoading(false);
      intent.current = null;
      setRuns((current) => [latestRun(current.find((run) => run.id === result.run.id), result.run), ...current.filter((run) => run.id !== result.run.id)]);
      setSelectedId(result.run.id);
    } catch (failure) {
      if (active.current) setError(errorMessage(failure));
    } finally {
      operation.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function cancel(run) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await post(`/api/agent/runs/${encodeURIComponent(run.id)}/cancel`, {});
      if (!active.current) return;
      refreshSequence.current += 1;
      setLoading(false);
      setRuns((current) => current.map((item) => item.id === run.id ? latestRun(item, result.run) : item));
    } catch (failure) {
      if (active.current) setError(errorMessage(failure));
    } finally {
      operation.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function apply(run) {
    if (operation.current || run.status !== "completed" || run.result?.status !== "proposal" || run.baseRevision !== revision) return;
    operation.current = true;
    setBusy(true);
    setError("");
    if (!appliedIntent.current.has(run.id)) appliedIntent.current.set(run.id, crypto.randomUUID());
    try {
      const result = await post(`/api/agent/runs/${encodeURIComponent(run.id)}/apply`, { requestId: appliedIntent.current.get(run.id) });
      if (!active.current) return;
      refreshSequence.current += 1;
      setLoading(false);
      onApplied(result);
      setRuns((current) => current.map((item) => item.id === run.id ? latestRun(item, result.run) : item));
    } catch (failure) {
      if (active.current) setError(errorMessage(failure));
    } finally {
      operation.current = false;
      if (active.current) setBusy(false);
    }
  }
  const proposedRecipes = selected?.result?.changes.filter((change) => change.type === "recipe").map((change) => change.data) ?? [];
  const recipes = new Map([...state.recipes, ...proposedRecipes].map((recipe) => [recipe.id, recipe]));
  const stale = Boolean(selected?.status === "completed" && selected.result?.status === "proposal" && selected.baseRevision !== revision);
  return /* @__PURE__ */ jsxs("div", { className: "agent-workspace", children: [
    /* @__PURE__ */ jsxs("div", { className: "agent-compose-layout", children: [
      /* @__PURE__ */ jsxs("form", { className: "agent-compose", onSubmit: start, children: [
        /* @__PURE__ */ jsx("div", { className: "eyebrow", children: "YOUR PLANS, WITH ROOM TO ADAPT" }),
        /* @__PURE__ */ jsx("h2", { children: "What would help today?" }),
        /* @__PURE__ */ jsx("p", { children: "Create a meal plan, build a routine, or work around a change of plans. The agent uses your profile and saved records." }),
        /* @__PURE__ */ jsxs("label", { className: "field", children: [
          /* @__PURE__ */ jsx("span", { children: "Your request" }),
          /* @__PURE__ */ jsx("textarea", { ref: textarea, rows: 5, maxLength: 6e3, required: true, minLength: 3, value: prompt, onChange: (event) => {
            setPrompt(event.target.value);
            intent.current = null;
          }, placeholder: "I have 30 minutes to train today. Adapt my planned workout to fit." })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "agent-suggestions", children: ["Build a training week around my goals.", "Plan varied meals for next week.", "Review my recent progress."].map((value) => /* @__PURE__ */ jsx("button", { type: "button", onClick: () => {
          setPrompt(value);
          intent.current = null;
          textarea.current?.focus();
        }, children: value }, value)) }),
        /* @__PURE__ */ jsxs("div", { className: "agent-submit-row", children: [
          /* @__PURE__ */ jsxs("label", { className: "field", children: [
            /* @__PURE__ */ jsx("span", { children: "Reference date" }),
            /* @__PURE__ */ jsx("input", { type: "date", required: true, value: date, onChange: (event) => {
              setDate(event.target.value);
              intent.current = null;
            } })
          ] }),
          /* @__PURE__ */ jsxs("button", { className: "button primary", type: "submit", disabled: busy || !ready || prompt.trim().length < 3 || runs.some(isActive), children: [
            busy ? /* @__PURE__ */ jsx(Loader2, { size: 16, className: "spin" }) : /* @__PURE__ */ jsx(Sparkles, { size: 16 }),
            busy ? "Please wait\u2026" : "Ask my agent"
          ] })
        ] }),
        /* @__PURE__ */ jsx("p", { className: "agent-review-note", children: "You\u2019ll review the details before any proposal changes your plans." })
      ] }),
      /* @__PURE__ */ jsx(AgentConnection, { onChanged: () => {
        void refresh();
        onRefresh();
      } })
    ] }),
    error && /* @__PURE__ */ jsx("p", { className: "form-error", role: "alert", children: error }),
    /* @__PURE__ */ jsxs("section", { className: "agent-history", "aria-label": "Agent requests", children: [
      /* @__PURE__ */ jsxs("div", { className: "section-heading", children: [
        /* @__PURE__ */ jsx("h2", { children: "Your requests" }),
        /* @__PURE__ */ jsxs("button", { className: "button subtle small", type: "button", disabled: loading || busy, onClick: () => void refresh(), children: [
          /* @__PURE__ */ jsx(RefreshCw, { size: 15, className: loading ? "spin" : "" }),
          "Refresh"
        ] })
      ] }),
      runs.length > 0 && /* @__PURE__ */ jsx("div", { className: "agent-run-picker", children: runs.slice(0, 20).map((run) => /* @__PURE__ */ jsxs("button", { type: "button", "aria-pressed": selected?.id === run.id, onClick: () => setSelectedId(run.id), children: [
        /* @__PURE__ */ jsx("span", { children: run.result?.title || run.prompt }),
        /* @__PURE__ */ jsxs("small", { children: [
          when(run.createdAt),
          " \xB7 ",
          run.status
        ] })
      ] }, run.id)) }),
      !loading && !runs.length && /* @__PURE__ */ jsxs("div", { className: "agent-empty", children: [
        /* @__PURE__ */ jsx(Sparkles, { size: 24 }),
        /* @__PURE__ */ jsx("h3", { children: "A useful next step starts here." }),
        /* @__PURE__ */ jsx("p", { children: "Ask a question or describe what you want to change. Your requests and reviewed proposals stay in this account." })
      ] })
    ] }),
    selected && /* @__PURE__ */ jsxs("section", { className: "agent-result", "aria-live": isActive(selected) ? "polite" : "off", "aria-busy": isActive(selected), children: [
      /* @__PURE__ */ jsxs("div", { className: "agent-result-top", children: [
        /* @__PURE__ */ jsx("span", { className: "eyebrow", children: selected.status === "applied" ? "APPLIED TO YOUR WORKSPACE" : isActive(selected) ? "WORKING ON YOUR REQUEST" : selected.result?.status === "proposal" ? "PROPOSAL \xB7 REVIEW BEFORE APPLYING" : "YOUR REQUEST" }),
        /* @__PURE__ */ jsx("p", { children: selected.prompt })
      ] }),
      isActive(selected) && /* @__PURE__ */ jsxs("div", { className: "agent-running", children: [
        /* @__PURE__ */ jsx(Loader2, { size: 22, className: "spin" }),
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("h3", { children: "Your agent is working." }),
          /* @__PURE__ */ jsx("p", { children: "This may take a little while. You can leave this page and return to the saved request." })
        ] }),
        /* @__PURE__ */ jsxs("button", { className: "button outline small", disabled: busy, onClick: () => void cancel(selected), children: [
          /* @__PURE__ */ jsx(Square, { size: 14 }),
          "Cancel request"
        ] })
      ] }),
      selected.status === "failed" && /* @__PURE__ */ jsx("p", { className: "form-error", role: "alert", children: selected.error || "The agent could not complete this request. Review your connection and try again." }),
      selected.status === "cancelled" && /* @__PURE__ */ jsx("p", { className: "agent-cancelled", children: "Request cancelled. No proposal was applied." }),
      selected.result && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsxs("div", { className: "agent-answer", children: [
          /* @__PURE__ */ jsx("h2", { children: selected.result.title }),
          /* @__PURE__ */ jsx("p", { children: selected.result.message }),
          selected.result.questions.length > 0 && /* @__PURE__ */ jsxs("div", { className: "agent-questions", children: [
            /* @__PURE__ */ jsx("h3", { children: "A little more detail" }),
            /* @__PURE__ */ jsx("ul", { children: selected.result.questions.map((question, index) => /* @__PURE__ */ jsx("li", { children: question }, index)) }),
            /* @__PURE__ */ jsxs("button", { className: "button outline small", onClick: () => {
              setPrompt(`${selected.prompt}

${selected.result.questions.map((question) => `${question}
`).join("\n")}`);
              intent.current = null;
              textarea.current?.focus();
              textarea.current?.scrollIntoView({ block: "center", behavior: "smooth" });
            }, children: [
              "Add details ",
              /* @__PURE__ */ jsx(ArrowRight, { size: 15 })
            ] })
          ] })
        ] }),
        selected.result.changes.length > 0 && /* @__PURE__ */ jsx("div", { className: "agent-changes", children: selected.result.changes.map((change, index) => /* @__PURE__ */ jsx(ChangePreview, { change, state, recipes }, `${change.type}-${index}`)) }),
        selected.status === "completed" && selected.result.status === "proposal" && /* @__PURE__ */ jsxs("div", { className: "agent-apply", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsxs("h3", { children: [
              selected.result.changes.length,
              " proposed ",
              selected.result.changes.length === 1 ? "change" : "changes"
            ] }),
            /* @__PURE__ */ jsx("p", { children: stale ? "Your workspace changed after this proposal. Ask for an updated version before applying it." : "Review every change above. Apply updates the plan; it does not log food or completed workouts." })
          ] }),
          stale ? /* @__PURE__ */ jsxs("button", { className: "button outline", disabled: busy, onClick: () => {
            setPrompt(selected.prompt);
            intent.current = null;
            textarea.current?.focus();
            textarea.current?.scrollIntoView({ block: "center", behavior: "smooth" });
          }, children: [
            "Update this request ",
            /* @__PURE__ */ jsx(ArrowRight, { size: 16 })
          ] }) : /* @__PURE__ */ jsxs("button", { className: "button primary", disabled: busy || loading, onClick: () => void apply(selected), children: [
            busy ? /* @__PURE__ */ jsx(Loader2, { size: 16, className: "spin" }) : /* @__PURE__ */ jsx(Check, { size: 16 }),
            "Apply ",
            selected.result.changes.length === 1 ? "change" : `${selected.result.changes.length} changes`
          ] })
        ] })
      ] }),
      selected.status === "applied" && /* @__PURE__ */ jsxs("p", { className: "agent-applied", children: [
        /* @__PURE__ */ jsx(Check, { size: 18 }),
        "Applied. Your plans are ready to review in the workspace."
      ] })
    ] })
  ] });
}
export {
  AgentConnection,
  AgentPanel as default
};
