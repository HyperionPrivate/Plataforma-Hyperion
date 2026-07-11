import type {
  LumenClinicalRecord,
  LumenClinicalRecordContent,
  LumenDictation,
  LumenEncounterDetail,
  LumenPreconsultationSummary,
  LumenWorklistEntry
} from "@hyperion/contracts";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  AudioLines,
  BellRing,
  BookOpenCheck,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  ClipboardCheck,
  Clock3,
  Eye,
  FileAudio,
  FileCheck2,
  FileText,
  HeartPulse,
  History,
  Info,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Mic,
  Pause,
  Pill as PillIcon,
  Play,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Square,
  Stethoscope,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { LumenWaveform } from "../components/lumen/LumenWaveform.js";
import { Layout } from "../components/Layout.js";
import { EmptyState, LoadingState, Pill } from "../components/ui.js";
import { ApiError, api } from "../lib/api.js";
import { lumenPath, useConsole } from "../lib/context.js";
import {
  LUMEN_CLINICAL_SECTION_KEYS,
  lumenApprovalBlockers,
  lumenReviewedSectionCount,
  lumenSectionHasValue
} from "../lib/lumen-clinical-state.js";
import { lumenErrorMessage } from "../lib/lumen-model.js";
import { LUMEN_VIEWS, lumenViewHref, resolveLumenLocation } from "../lib/lumen-navigation.js";
import {
  lumenAlertSource,
  lumenSummarySourceById,
  lumenTrendDomain,
  lumenTrendTargetLabel,
  type LumenSummarySource
} from "../lib/lumen-preconsultation.js";
import {
  LUMEN_ALLOWED_AUDIO_MIME_TYPES,
  clampLumenRecordingDuration,
  lumenAudioPayloadFingerprint,
  lumenRecordingReachedLimit,
  lumenStructurePayloadFingerprint,
  measureLumenAudioDuration,
  isLumenAudioTransportAllowed,
  resolveLumenIdempotencySlot,
  resolveLumenIdempotencySlotAfterFailure,
  validateLumenAudio,
  type LumenAudioValidationCode,
  type LumenIdempotencyFailure,
  type LumenIdempotencySlot
} from "../lib/lumen-recording.js";
import {
  isCurrentLumenEncounter,
  lumenWorklistForSite,
  resolveLumenEncounterSelection
} from "../lib/lumen-selection.js";
import { can } from "../lib/rbac.js";

interface LumenHealth {
  providers: { transcriptionConfigured: boolean; structuringConfigured: boolean };
}

type Action = "loading" | "starting" | "processing_audio" | "transcribing" | "structuring" | "saving" | "approving";
type AudioSource = "browser_microphone" | "authorized_upload";
type DictationFlowState =
  | "ready"
  | "recording"
  | "processing_audio"
  | "transcribing"
  | "structuring"
  | "completed"
  | "recoverable_error"
  | "not_configured";

const LUMEN_SECURE_AUDIO_MESSAGE =
  "Audio bloqueado: la grabación y la carga requieren HTTPS o un túnel local en localhost. El transcript manual sigue disponible.";

interface RecordingSession {
  encounterId: string;
  cancelled: boolean;
  activeSeconds: number;
}

interface RetryableAudio {
  blob: Blob;
  durationSeconds: number;
  source: AudioSource;
  encounterId: string;
}

export function LumenPage() {
  const { tenant, session, activeSiteId } = useConsole();
  const location = useLocation();
  const navigate = useNavigate();
  const activeView = resolveLumenLocation(location)?.viewId ?? "preconsulta";
  const [worklist, setWorklist] = useState<LumenWorklistEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<LumenEncounterDetail>();
  const [draft, setDraft] = useState<LumenClinicalRecordContent>();
  const [transcript, setTranscript] = useState("");
  const [activeDictationId, setActiveDictationId] = useState<string>();
  const [health, setHealth] = useState<LumenHealth>();
  const [action, setAction] = useState<Action>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [recording, setRecording] = useState(false);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioPreview, setAudioPreview] = useState<Blob>();
  const [dictationFlow, setDictationFlow] = useState<DictationFlowState>("ready");
  const [worklistLoaded, setWorklistLoaded] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingSessionRef = useRef<RecordingSession | undefined>(undefined);
  const recordingRequestRef = useRef(0);
  const transcriptionRequestRef = useRef(0);
  const dictationAbortRef = useRef<AbortController | undefined>(undefined);
  const activeDictationIdRef = useRef<string | undefined>(undefined);
  const audioIdempotencyRef = useRef<LumenIdempotencySlot | undefined>(undefined);
  const structureIdempotencyRef = useRef<LumenIdempotencySlot | undefined>(undefined);
  const retryableAudioRef = useRef<RetryableAudio | undefined>(undefined);
  const detailRequestRef = useRef(0);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const detailEncounterIdRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);
  const previousViewRef = useRef(activeView);

  const canWrite = can(session.operator.role, "write:lumen");
  const audioTransportAllowed = currentLumenAudioTransportAllowed();

  useEffect(() => {
    const resolved = resolveLumenLocation(location);
    const normalizedHref = resolved?.href ?? lumenViewHref("preconsulta", location);
    if (`${location.pathname}${location.search}` !== normalizedHref) navigate(normalizedHref, { replace: true });
  }, [location, navigate]);

  const visibleWorklist = useMemo(() => lumenWorklistForSite(worklist, activeSiteId), [activeSiteId, worklist]);

  const applyDetail = useCallback((next: LumenEncounterDetail) => {
    const latestDictation = next.dictations[0];
    detailEncounterIdRef.current = next.encounter.encounterId;
    activeDictationIdRef.current = latestDictation?.id;
    setDetail(next);
    setDraft(next.clinicalRecord?.content);
    setTranscript(latestDictation?.transcript ?? "");
    setActiveDictationId(latestDictation?.id);
  }, []);

  const discardRecording = useCallback((updateUi = true) => {
    recordingRequestRef.current += 1;
    transcriptionRequestRef.current += 1;
    dictationAbortRef.current?.abort();
    dictationAbortRef.current = undefined;
    const session = recordingSessionRef.current;
    if (session) session.cancelled = true;
    chunksRef.current = [];
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    streamRef.current = null;
    recordingSessionRef.current = undefined;
    if (updateUi) {
      setRecording(false);
      setRecordingPaused(false);
      setRecordingSeconds(0);
      setAudioPreview(undefined);
    }
  }, []);

  const loadDetail = useCallback(
    async (encounterId: string) => {
      const requestId = ++detailRequestRef.current;
      const next = await api.get<LumenEncounterDetail>(lumenPath(tenant.id, `encounters/${encounterId}`));
      if (requestId !== detailRequestRef.current || selectedIdRef.current !== encounterId) return;
      applyDetail(next);
    },
    [applyDetail, tenant.id]
  );

  const refreshWorklist = useCallback(
    async (signal?: AbortSignal) => {
      const rows = await api.get<LumenWorklistEntry[]>(lumenPath(tenant.id, "worklist"), signal);
      setWorklist(rows);
      return rows;
    },
    [tenant.id]
  );

  useEffect(() => {
    let cancelled = false;
    discardRecording();
    detailRequestRef.current += 1;
    selectedIdRef.current = undefined;
    detailEncounterIdRef.current = undefined;
    setSelectedId(undefined);
    setDetail(undefined);
    setDraft(undefined);
    setTranscript("");
    activeDictationIdRef.current = undefined;
    setActiveDictationId(undefined);
    setWorklistLoaded(false);
    setAction("loading");
    setError(undefined);
    void (async () => {
      try {
        const [rows, providerHealth] = await Promise.all([
          api.get<LumenWorklistEntry[]>(lumenPath(tenant.id, "worklist")),
          api.get<LumenHealth>("/v1/lumen/health")
        ]);
        if (cancelled) return;
        setWorklist(rows);
        setHealth(providerHealth);
        setDictationFlow(providerHealth.providers.transcriptionConfigured ? "ready" : "not_configured");
        setWorklistLoaded(true);
      } catch (nextError) {
        if (!cancelled) {
          setError(lumenErrorMessage(nextError));
          setDictationFlow("recoverable_error");
        }
      } finally {
        if (!cancelled) setAction(undefined);
      }
    })();
    return () => {
      cancelled = true;
      detailRequestRef.current += 1;
    };
  }, [discardRecording, tenant.id]);

  useEffect(() => {
    if (!worklistLoaded) return;
    const requestedId = new URLSearchParams(location.search).get("encounter")?.trim() || undefined;
    const nextId = resolveLumenEncounterSelection(visibleWorklist, requestedId, selectedIdRef.current);

    if (!nextId) {
      discardRecording();
      detailRequestRef.current += 1;
      selectedIdRef.current = undefined;
      detailEncounterIdRef.current = undefined;
      setSelectedId(undefined);
      setDetail(undefined);
      setDraft(undefined);
      setTranscript("");
      activeDictationIdRef.current = undefined;
      setActiveDictationId(undefined);
      setAudioPreview(undefined);
      if (requestedId) navigate(encounterHref(location.pathname), { replace: true });
      return;
    }

    const selectionChanged = selectedIdRef.current !== nextId;
    const detailMissing = detailEncounterIdRef.current !== nextId;
    if (!selectionChanged && !detailMissing && requestedId === nextId) return;

    if (selectionChanged) {
      discardRecording();
      detailRequestRef.current += 1;
      selectedIdRef.current = nextId;
      detailEncounterIdRef.current = undefined;
      setSelectedId(nextId);
      setDetail(undefined);
      setDraft(undefined);
      setTranscript("");
      activeDictationIdRef.current = undefined;
      setActiveDictationId(undefined);
      setDictationFlow(health?.providers.transcriptionConfigured ? "ready" : "not_configured");
      setError(undefined);
      setSuccess(undefined);
    }
    if (requestedId !== nextId) navigate(encounterHref(location.pathname, nextId), { replace: true });
    if (!detailMissing) return;

    setAction("loading");
    void (async () => {
      try {
        await loadDetail(nextId);
      } catch (nextError) {
        if (isCurrentLumenEncounter(nextId, selectedIdRef.current)) setError(lumenErrorMessage(nextError));
      } finally {
        if (isCurrentLumenEncounter(nextId, selectedIdRef.current)) {
          setAction((current) => (current === "loading" ? undefined : current));
        }
      }
    })();
  }, [
    discardRecording,
    health?.providers.transcriptionConfigured,
    loadDetail,
    location.pathname,
    location.search,
    navigate,
    visibleWorklist,
    worklistLoaded
  ]);

  useEffect(() => {
    if (!recording || recordingPaused) return;
    const timer = window.setInterval(() => {
      const session = recordingSessionRef.current;
      if (!session || session.cancelled) return;
      session.activeSeconds += 1;
      setRecordingSeconds(session.activeSeconds);
      if (lumenRecordingReachedLimit(session.activeSeconds)) {
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== "inactive") recorder.stop();
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [recording, recordingPaused]);

  useEffect(() => {
    if (previousViewRef.current !== activeView) {
      discardRecording();
      previousViewRef.current = activeView;
    }
  }, [activeView, discardRecording]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detailRequestRef.current += 1;
      transcriptionRequestRef.current += 1;
      discardRecording(false);
    };
  }, [discardRecording]);

  function selectEncounter(encounterId: string, replace = false) {
    if (action || recording) return;
    navigate(encounterHref(location.pathname, encounterId), { replace });
  }

  function goToView(view: (typeof LUMEN_VIEWS)[number]["id"]) {
    discardRecording();
    const target = LUMEN_VIEWS.find((entry) => entry.id === view)?.path ?? "/lumen/preconsulta";
    navigate(
      lumenViewHref(view, {
        pathname: target,
        search: selectedId ? `?encounter=${encodeURIComponent(selectedId)}` : ""
      })
    );
  }

  async function startEncounter(goToDictation = false) {
    const targetEncounterId = selectedIdRef.current;
    if (!targetEncounterId || detailEncounterIdRef.current !== targetEncounterId) return;
    if (detail?.encounter.status !== "preconsultation") {
      if (goToDictation && isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) goToView("dictado");
      return;
    }
    await runAction("starting", targetEncounterId, async () => {
      const next = await api.post<LumenEncounterDetail>(
        lumenPath(tenant.id, `encounters/${targetEncounterId}/start`),
        {}
      );
      if (!isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
      applyDetail(next);
      await refreshWorklist();
      if (!isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
      setSuccess("Encuentro clínico iniciado.");
      if (goToDictation) goToView("dictado");
    });
  }

  async function startRecording() {
    const targetEncounterId = selectedIdRef.current;
    if (!targetEncounterId || detailEncounterIdRef.current !== targetEncounterId) return;
    const recordingRequestId = ++recordingRequestRef.current;
    setError(undefined);
    setSuccess(undefined);
    if (!currentLumenAudioTransportAllowed()) {
      setError(LUMEN_SECURE_AUDIO_MESSAGE);
      setDictationFlow("recoverable_error");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError(
        "Este navegador no permite captura de audio. La carga autorizada y el transcript manual siguen disponibles."
      );
      setDictationFlow("recoverable_error");
      return;
    }
    if (!health?.providers.transcriptionConfigured) {
      setError("Voz sin configurar. Puedes cargar audio para revisión visual o continuar con transcript manual.");
      setDictationFlow("not_configured");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      if (
        recordingRequestId !== recordingRequestRef.current ||
        !isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current) ||
        !mountedRef.current
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const chunks: Blob[] = [];
      chunksRef.current = chunks;
      setAudioPreview(undefined);
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"].find(
        (candidate) => MediaRecorder.isTypeSupported(candidate)
      );
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 32_000
      });
      const session: RecordingSession = { encounterId: targetEncounterId, cancelled: false, activeSeconds: 0 };
      recordingSessionRef.current = session;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const ownsCurrentSession = recordingSessionRef.current === session;
        if (ownsCurrentSession) {
          recorderRef.current = null;
          streamRef.current = null;
          recordingSessionRef.current = undefined;
        }
        if (session.cancelled || !mountedRef.current) return;
        if (ownsCurrentSession) {
          setRecording(false);
          setRecordingPaused(false);
          setDictationFlow("processing_audio");
        }
        const blob = new Blob(chunks, { type: recorder.mimeType });
        void transcribeAudio(
          blob,
          clampLumenRecordingDuration(session.activeSeconds),
          "browser_microphone",
          session.encounterId
        );
      };
      setRecordingSeconds(0);
      setRecordingPaused(false);
      setRecording(true);
      setDictationFlow("recording");
      recorder.start(500);
    } catch (nextError) {
      discardRecording();
      setError(lumenErrorMessage(nextError));
      setDictationFlow("recoverable_error");
    }
  }

  function toggleRecordingPause() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      setRecordingPaused(true);
    } else if (recorder.state === "paused") {
      recorder.resume();
      setRecordingPaused(false);
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      setDictationFlow("processing_audio");
      recorderRef.current.stop();
    }
  }

  async function uploadAudio(file: File | undefined) {
    if (!file) return;
    const targetEncounterId = selectedIdRef.current;
    if (!targetEncounterId || detailEncounterIdRef.current !== targetEncounterId) return;
    await transcribeAudio(file, undefined, "authorized_upload", targetEncounterId);
  }

  async function transcribeAudio(
    blob: Blob,
    durationSeconds: number | undefined,
    source: AudioSource,
    targetEncounterId: string,
    isRetry = false
  ) {
    if (!currentLumenAudioTransportAllowed()) {
      setError(LUMEN_SECURE_AUDIO_MESSAGE);
      setSuccess(undefined);
      setDictationFlow("recoverable_error");
      return;
    }
    const transcriptionRequestId = ++transcriptionRequestRef.current;
    let requestIdempotency: LumenIdempotencySlot | undefined;
    let operationResponseReceived = false;
    dictationAbortRef.current?.abort();
    const controller = new AbortController();
    dictationAbortRef.current = controller;
    setAction("processing_audio");
    setDictationFlow("processing_audio");
    setError(undefined);
    setSuccess(undefined);
    if (!isRetry) {
      retryableAudioRef.current = undefined;
      setAudioPreview(undefined);
    }

    try {
      const descriptor = validateLumenAudio({ mimeType: blob.type, size: blob.size });
      if (!descriptor.valid || !descriptor.mimeType) {
        setError(lumenAudioValidationMessage(descriptor.code));
        setDictationFlow("recoverable_error");
        return;
      }
      const measuredDuration = durationSeconds ?? (await measureLumenAudioDuration(blob, controller.signal));
      const validated = validateLumenAudio({
        mimeType: descriptor.mimeType,
        size: blob.size,
        durationSeconds: measuredDuration
      });
      if (!validated.valid || !validated.mimeType || validated.durationSeconds === undefined) {
        setError(lumenAudioValidationMessage(validated.code));
        setDictationFlow("recoverable_error");
        return;
      }
      if (controller.signal.aborted || transcriptionRequestId !== transcriptionRequestRef.current) return;
      setAudioPreview(blob);
      if (!health?.providers.transcriptionConfigured) {
        setSuccess("Audio autorizado validado localmente. Voz sin configurar; el archivo no salió del navegador.");
        setDictationFlow("not_configured");
        return;
      }

      retryableAudioRef.current = {
        blob,
        durationSeconds: validated.durationSeconds,
        source,
        encounterId: targetEncounterId
      };

      const audioBase64 = await blobToBase64(blob, controller.signal);
      if (controller.signal.aborted || transcriptionRequestId !== transcriptionRequestRef.current) return;
      const fingerprint = await lumenAudioPayloadFingerprint({
        scope: `${tenant.id}:${targetEncounterId}`,
        audioBase64,
        mimeType: validated.mimeType,
        source,
        durationSeconds: validated.durationSeconds
      });
      if (controller.signal.aborted || transcriptionRequestId !== transcriptionRequestRef.current) return;
      const idempotency = resolveLumenIdempotencySlot(audioIdempotencyRef.current, fingerprint);
      audioIdempotencyRef.current = idempotency;
      requestIdempotency = idempotency;
      setAction("transcribing");
      setDictationFlow("transcribing");
      const dictation = await api.post<LumenDictation>(
        lumenPath(tenant.id, `encounters/${targetEncounterId}/transcriptions`),
        {
          audioBase64,
          mimeType: validated.mimeType,
          durationSeconds: validated.durationSeconds,
          source,
          idempotencyKey: idempotency.key
        },
        controller.signal
      );
      operationResponseReceived = true;
      if (
        controller.signal.aborted ||
        transcriptionRequestId !== transcriptionRequestRef.current ||
        !isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)
      ) {
        return;
      }
      activeDictationIdRef.current = dictation.id;
      setActiveDictationId(dictation.id);
      setTranscript(dictation.transcript);
      await reloadEncounter(targetEncounterId, controller.signal);
      if (controller.signal.aborted || !isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
      activeDictationIdRef.current = dictation.id;
      setActiveDictationId(dictation.id);
      setTranscript(dictation.transcript);
      setSuccess("Transcripción recibida del proveedor configurado.");
      if (audioIdempotencyRef.current === idempotency) audioIdempotencyRef.current = undefined;
      retryableAudioRef.current = undefined;
      setAudioPreview(undefined);
      setDictationFlow("completed");
    } catch (nextError) {
      if (requestIdempotency && audioIdempotencyRef.current === requestIdempotency && !operationResponseReceived) {
        audioIdempotencyRef.current = resolveLumenIdempotencySlotAfterFailure(
          audioIdempotencyRef.current,
          lumenIdempotencyFailure(nextError)
        );
      }
      if (
        mountedRef.current &&
        !isAbortError(nextError) &&
        isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)
      ) {
        setError(
          nextError instanceof Error && nextError.message.startsWith("audio_metadata_")
            ? "No fue posible leer la duración del audio. Usa un archivo reproducible de máximo 90 segundos."
            : lumenErrorMessage(nextError)
        );
        setDictationFlow("recoverable_error");
      }
    } finally {
      if (dictationAbortRef.current === controller) dictationAbortRef.current = undefined;
      if (mountedRef.current && isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) {
        setAction((current) => (current === "processing_audio" || current === "transcribing" ? undefined : current));
      }
    }
  }

  async function structureRecord() {
    const targetEncounterId = selectedIdRef.current;
    const targetTranscript = transcript;
    if (
      !targetEncounterId ||
      detailEncounterIdRef.current !== targetEncounterId ||
      targetTranscript.trim().length < 10
    ) {
      setError("El transcript debe tener al menos 10 caracteres.");
      setDictationFlow("recoverable_error");
      return;
    }
    if (!health?.providers.structuringConfigured) {
      setError("Estructuración sin configurar. El transcript permanece disponible para revisión manual.");
      setDictationFlow("not_configured");
      return;
    }
    dictationAbortRef.current?.abort();
    const controller = new AbortController();
    dictationAbortRef.current = controller;
    const targetDictationId = activeDictationIdRef.current ?? activeDictationId;
    const fingerprint = lumenStructurePayloadFingerprint({
      scope: `${tenant.id}:${targetEncounterId}`,
      dictationId: targetDictationId,
      transcript: targetTranscript
    });
    const idempotency = resolveLumenIdempotencySlot(structureIdempotencyRef.current, fingerprint);
    structureIdempotencyRef.current = idempotency;
    let operationResponseReceived = false;
    setAction("structuring");
    setDictationFlow("structuring");
    setError(undefined);
    setSuccess(undefined);
    try {
      const record = await api.post<LumenClinicalRecord>(
        lumenPath(tenant.id, `encounters/${targetEncounterId}/structure`),
        { transcript: targetTranscript, dictationId: targetDictationId, idempotencyKey: idempotency.key },
        controller.signal
      );
      operationResponseReceived = true;
      if (controller.signal.aborted || !isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
      setDraft(record.content);
      await reloadEncounter(targetEncounterId, controller.signal);
      if (controller.signal.aborted || !isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
      setDraft(record.content);
      await refreshWorklist(controller.signal);
      if (controller.signal.aborted || !isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
      setSuccess("Historia estructurada por el proveedor y enviada a revisión humana.");
      if (structureIdempotencyRef.current === idempotency) structureIdempotencyRef.current = undefined;
      setDictationFlow("completed");
      goToView("historia");
    } catch (nextError) {
      if (structureIdempotencyRef.current === idempotency && !operationResponseReceived) {
        structureIdempotencyRef.current = resolveLumenIdempotencySlotAfterFailure(
          structureIdempotencyRef.current,
          lumenIdempotencyFailure(nextError)
        );
      }
      if (
        mountedRef.current &&
        !isAbortError(nextError) &&
        isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)
      ) {
        setError(lumenErrorMessage(nextError));
        setDictationFlow("recoverable_error");
      }
    } finally {
      if (dictationAbortRef.current === controller) dictationAbortRef.current = undefined;
      if (mountedRef.current && isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) {
        setAction((current) => (current === "structuring" ? undefined : current));
      }
    }
  }

  async function reloadEncounter(targetEncounterId: string, signal?: AbortSignal) {
    const next = await api.get<LumenEncounterDetail>(lumenPath(tenant.id, `encounters/${targetEncounterId}`), signal);
    if (!isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
    applyDetail(next);
  }

  function cancelDictationOperation() {
    const wasRecording = Boolean(recordingSessionRef.current);
    const hadRetryableAudio = Boolean(retryableAudioRef.current);
    const cancelledAction = action;
    transcriptionRequestRef.current += 1;
    dictationAbortRef.current?.abort();
    dictationAbortRef.current = undefined;
    discardRecording();
    setAction((current) =>
      current === "processing_audio" || current === "transcribing" || current === "structuring" ? undefined : current
    );
    if (
      wasRecording ||
      hadRetryableAudio ||
      cancelledAction === "processing_audio" ||
      cancelledAction === "transcribing"
    ) {
      audioIdempotencyRef.current = resolveLumenIdempotencySlotAfterFailure(audioIdempotencyRef.current, {
        kind: "abort"
      });
      retryableAudioRef.current = undefined;
    }
    if (cancelledAction === "structuring") {
      structureIdempotencyRef.current = resolveLumenIdempotencySlotAfterFailure(structureIdempotencyRef.current, {
        kind: "abort"
      });
    }
    setError(undefined);
    setSuccess(
      wasRecording || hadRetryableAudio
        ? "Audio descartado; no se conserva en el navegador."
        : "Operación cancelada de forma segura."
    );
    setDictationFlow(health?.providers.transcriptionConfigured ? "ready" : "not_configured");
  }

  function retryAudioTranscription() {
    const pending = retryableAudioRef.current;
    if (!pending || pending.encounterId !== selectedIdRef.current) return;
    void transcribeAudio(pending.blob, pending.durationSeconds, pending.source, pending.encounterId, true);
  }

  function editTranscript(value: string) {
    // The source dictation identity intentionally survives human transcript corrections.
    setTranscript(value);
    if (dictationFlow === "recoverable_error") {
      setDictationFlow(health?.providers.transcriptionConfigured ? "ready" : "not_configured");
    }
  }

  async function saveDraft(
    targetEncounterId: string,
    targetDraft: LumenClinicalRecordContent
  ): Promise<LumenClinicalRecord | undefined> {
    if (detailEncounterIdRef.current !== targetEncounterId) return undefined;
    return api.patch<LumenClinicalRecord>(lumenPath(tenant.id, `encounters/${targetEncounterId}/record`), {
      content: targetDraft
    });
  }

  async function save() {
    const targetEncounterId = selectedIdRef.current;
    const targetDraft = draft;
    if (!targetEncounterId || !targetDraft || detailEncounterIdRef.current !== targetEncounterId) return;
    await runAction("saving", targetEncounterId, async () => {
      const record = await saveDraft(targetEncounterId, targetDraft);
      if (!record) return;
      if (!isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
      setDraft(record.content);
      setDetail((current) =>
        current?.encounter.encounterId === targetEncounterId ? { ...current, clinicalRecord: record } : current
      );
      setSuccess("Borrador clínico guardado con trazabilidad de revisión.");
    });
  }

  async function approve() {
    const targetEncounterId = selectedIdRef.current;
    const targetDraft = draft;
    if (!targetEncounterId || !targetDraft || detailEncounterIdRef.current !== targetEncounterId) return;
    await runAction("approving", targetEncounterId, async () => {
      await saveDraft(targetEncounterId, targetDraft);
      if (!isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
      const record = await api.post<LumenClinicalRecord>(
        lumenPath(tenant.id, `encounters/${targetEncounterId}/approve`),
        {}
      );
      if (!isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
      setDraft(record.content);
      await reloadEncounter(targetEncounterId);
      if (!isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
      await refreshWorklist();
      if (!isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) return;
      setSuccess("Historia clínica aprobada por el profesional y cerrada.");
    });
  }

  async function runAction(nextAction: Action, targetEncounterId: string, work: () => Promise<void>) {
    setAction(nextAction);
    setError(undefined);
    setSuccess(undefined);
    try {
      await work();
    } catch (nextError) {
      if (isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) setError(lumenErrorMessage(nextError));
    } finally {
      if (isCurrentLumenEncounter(targetEncounterId, selectedIdRef.current)) {
        setAction((current) => (current === nextAction ? undefined : current));
      }
    }
  }

  function updateEye(
    section: "visualAcuity" | "intraocularPressure" | "biomicroscopy" | "gonioscopy" | "fundus",
    eye: "right" | "left",
    value: string
  ) {
    setDraft((current) =>
      current ? { ...current, [section]: { ...current[section], [eye]: value.trim() ? value : null } } : current
    );
  }

  function resolveUncertainty(index: number) {
    setDraft((current) =>
      current
        ? { ...current, uncertainties: current.uncertainties.filter((_, itemIndex) => itemIndex !== index) }
        : current
    );
  }

  const busy = Boolean(action);
  const interactionLocked = busy || recording;
  const displayedDetail =
    detail && visibleWorklist.some((entry) => entry.encounterId === detail.encounter.encounterId) ? detail : undefined;
  const approved = displayedDetail?.clinicalRecord?.status === "approved";
  const recordLocked = Boolean(approved || !canWrite);
  const activeStream = recording && !recordingPaused ? streamRef.current : null;

  return (
    <Layout
      className="lumen-shell-host"
      title="LUMEN"
      subtitle="Asistente clínico por voz"
      actions={
        <div className="lumen-provider-status" aria-label="Estado de proveedores clínicos">
          <Pill tone={health?.providers.transcriptionConfigured ? "green" : "amber"}>
            <Mic size={13} aria-hidden="true" /> Voz{" "}
            {health?.providers.transcriptionConfigured ? "lista" : "sin configurar"}
          </Pill>
          <Pill tone={health?.providers.structuringConfigured ? "green" : "amber"}>
            <Sparkles size={13} aria-hidden="true" /> Estructuración{" "}
            {health?.providers.structuringConfigured ? "lista" : "sin configurar"}
          </Pill>
          {!canWrite ? <Pill tone="blue">Solo lectura</Pill> : null}
        </div>
      }
    >
      <div className="lumen-page">
        <header className="lumen-product-header">
          <div className="lumen-wordmark" aria-label="LUMEN Hyperion One">
            <AudioLines size={28} strokeWidth={1.8} aria-hidden="true" />
            <span>LUMEN</span>
            <small>HYPERION ONE</small>
          </div>
          <nav className="lumen-product-nav" aria-label="Experiencias LUMEN">
            {LUMEN_VIEWS.map((view) => {
              const Icon = view.id === "preconsulta" ? HeartPulse : view.id === "dictado" ? Mic : FileCheck2;
              return (
                <NavLink
                  key={view.id}
                  to={encounterHref(view.path, selectedId)}
                  className={({ isActive }) =>
                    `lumen-product-link${isActive ? " active" : ""}${interactionLocked ? " disabled" : ""}`
                  }
                  aria-label={view.label}
                  aria-disabled={interactionLocked}
                  onClick={(event) => {
                    if (interactionLocked) event.preventDefault();
                  }}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>
                    {view.id === "preconsulta" ? "Preconsulta" : view.id === "dictado" ? "Dictado" : "Historia"}
                  </span>
                </NavLink>
              );
            })}
          </nav>
        </header>

        {error ? (
          <div className="lumen-feedback lumen-feedback-error" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
        {success ? (
          <div className="lumen-feedback lumen-feedback-success" role="status" aria-live="polite">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>{success}</span>
          </div>
        ) : null}

        <AgendaStrip
          rows={visibleWorklist}
          selectedId={selectedId}
          loading={action === "loading" && worklist.length === 0}
          disabled={interactionLocked}
          onSelect={(encounterId) => selectEncounter(encounterId)}
        />

        {displayedDetail ? <PatientContext detail={displayedDetail} /> : null}

        {action === "loading" && !displayedDetail ? <LoadingState label="Cargando encuentro clínico..." /> : null}
        {!displayedDetail && action !== "loading" ? (
          <EmptyState label="No hay encuentros sintéticos disponibles para esta sede." />
        ) : null}

        {displayedDetail && activeView === "preconsulta" ? (
          <PreconsultationView
            detail={displayedDetail}
            canWrite={canWrite}
            busy={busy}
            onStart={() => void startEncounter(true)}
            onOpenDictation={() => goToView("dictado")}
            onOpenRecord={() => goToView("historia")}
          />
        ) : null}

        {displayedDetail && activeView === "dictado" ? (
          <DictationView
            detail={displayedDetail}
            draft={draft}
            transcript={transcript}
            health={health}
            audioTransportAllowed={audioTransportAllowed}
            action={action}
            flowState={dictationFlow}
            canRetryAudio={dictationFlow === "recoverable_error" && Boolean(retryableAudioRef.current)}
            recording={recording}
            paused={recordingPaused}
            seconds={recordingSeconds}
            stream={activeStream}
            audioPreview={audioPreview}
            locked={recordLocked || busy}
            onTranscriptChange={editTranscript}
            onStart={() => void startRecording()}
            onPause={toggleRecordingPause}
            onStop={stopRecording}
            onCancel={cancelDictationOperation}
            onRetryAudio={retryAudioTranscription}
            onUpload={(file) => void uploadAudio(file)}
            onStructure={() => void structureRecord()}
          />
        ) : null}

        {displayedDetail && activeView === "historia" ? (
          <ClinicalRecordView
            detail={displayedDetail}
            draft={draft}
            action={action}
            locked={recordLocked}
            canWrite={canWrite}
            onDraftChange={setDraft}
            onEyeChange={updateEye}
            onResolveUncertainty={resolveUncertainty}
            onSave={() => void save()}
            onApprove={() => void approve()}
            onOpenDictation={() => goToView("dictado")}
          />
        ) : null}
      </div>
    </Layout>
  );
}

function AgendaStrip({
  rows,
  selectedId,
  loading,
  disabled,
  onSelect
}: {
  rows: LumenWorklistEntry[];
  selectedId?: string;
  loading: boolean;
  disabled: boolean;
  onSelect: (encounterId: string) => void;
}) {
  return (
    <section className="lumen-agenda" aria-labelledby="lumen-agenda-title">
      <div className="lumen-agenda-title">
        <CalendarDays size={18} aria-hidden="true" />
        <div>
          <h2 id="lumen-agenda-title">Agenda clínica</h2>
          <span>{rows.length} encuentro(s) de demo</span>
        </div>
      </div>
      {loading ? <LoadingState label="Cargando agenda..." /> : null}
      {!loading && rows.length === 0 ? <span className="lumen-empty-inline">Sin encuentros sintéticos.</span> : null}
      <div className="lumen-agenda-list">
        {rows.map((entry) => (
          <button
            type="button"
            key={entry.encounterId}
            className={`lumen-agenda-item${selectedId === entry.encounterId ? " active" : ""}`}
            aria-pressed={selectedId === entry.encounterId}
            disabled={disabled}
            onClick={() => onSelect(entry.encounterId)}
          >
            <span className="lumen-agenda-time">{formatTime(entry.scheduledAt)}</span>
            <span className="lumen-agenda-patient">
              <strong>{entry.patientDisplayName}</strong>
              <small>{entry.visitReason ?? entry.subspecialty ?? "Consulta oftalmológica"}</small>
            </span>
            <StatusBadge status={entry.status} />
            {entry.isDemo ? <span className="lumen-synthetic-mini">Sintético</span> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function PatientContext({ detail }: { detail: LumenEncounterDetail }) {
  const encounter = detail.encounter;
  return (
    <section className="lumen-patient-context" aria-label="Paciente y encuentro en contexto">
      <div className="lumen-patient-avatar" aria-hidden="true">
        {initials(encounter.patientDisplayName)}
      </div>
      <div className="lumen-patient-primary">
        <span className="lumen-eyebrow">Paciente en contexto</span>
        <strong>{encounter.patientDisplayName}</strong>
        <span>
          {encounter.patientAge ? `${encounter.patientAge} años` : "Edad no registrada"}
          {encounter.documentMasked ? ` · ${encounter.documentMasked}` : ""}
          {encounter.payer ? ` · ${encounter.payer}` : ""}
        </span>
      </div>
      <div className="lumen-context-fact">
        <Stethoscope size={17} aria-hidden="true" />
        <span>
          <small>Profesional</small>
          <strong>{encounter.professionalName}</strong>
        </span>
      </div>
      <div className="lumen-context-fact">
        <Clock3 size={17} aria-hidden="true" />
        <span>
          <small>Encuentro</small>
          <strong>{statusLabel(encounter.status)}</strong>
        </span>
      </div>
      <span className="lumen-synthetic-badge">
        <ShieldCheck size={15} aria-hidden="true" /> Datos sintéticos · Demo
      </span>
    </section>
  );
}

function PreconsultationView({
  detail,
  canWrite,
  busy,
  onStart,
  onOpenDictation,
  onOpenRecord
}: {
  detail: LumenEncounterDetail;
  canWrite: boolean;
  busy: boolean;
  onStart: () => void;
  onOpenDictation: () => void;
  onOpenRecord: () => void;
}) {
  const summary = detail.preconsultation;
  const encounter = detail.encounter;
  const actionLabel = encounter.status === "preconsultation" ? "Iniciar consulta con dictado" : "Abrir dictado clínico";

  if (!summary) {
    return (
      <section className="lumen-view" aria-labelledby="preconsultation-title">
        <ViewTitle
          id="preconsultation-title"
          eyebrow="Preparación del encuentro"
          title="Resumen preconsulta"
          description="Primera atención en CEDCO — sin historial previo disponible."
        />
        <div className="lumen-empty-panel">
          <History size={28} aria-hidden="true" />
          <h2>Sin resumen clínico previo</h2>
          <p>No se muestran afirmaciones clínicas sin una fuente registrada.</p>
          {canWrite ? (
            <button className="btn btn-primary" type="button" onClick={onStart} disabled={busy}>
              <Mic size={17} aria-hidden="true" /> {actionLabel}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="lumen-view" aria-labelledby="preconsultation-title">
      <ViewTitle
        id="preconsultation-title"
        eyebrow="Preparación del encuentro"
        title="Resumen preconsulta"
        description={`${encounter.visitReason ?? "Control oftalmológico"} · ${formatTime(encounter.scheduledAt)}`}
      />
      <div className="lumen-pre-layout">
        <div className="lumen-pre-main">
          <article className="lumen-summary-hero">
            <span className="lumen-summary-spark" aria-hidden="true">
              <Sparkles size={24} />
            </span>
            <div>
              <p>{summary.summaryText}</p>
              <span className="lumen-summary-meta">
                <ShieldCheck size={15} aria-hidden="true" /> {summary.sourceCount} fuentes clínicas · Síntesis sin datos
                inferidos
              </span>
            </div>
          </article>

          <section className="lumen-alert-card" aria-labelledby="summary-alerts-title">
            <CardTitle
              icon={<BellRing size={19} aria-hidden="true" />}
              title={`Alertas (${summary.alerts.length})`}
              id="summary-alerts-title"
            />
            <div className="lumen-alert-list">
              {summary.alerts.length === 0 ? (
                <span className="lumen-empty-inline">Sin alertas registradas.</span>
              ) : null}
              {summary.alerts.map((alert, index) => (
                <div className={`lumen-alert-row ${index === 0 ? "danger" : "warning"}`} key={alert}>
                  {index === 0 ? (
                    <AlertCircle size={19} aria-hidden="true" />
                  ) : (
                    <AlertTriangle size={19} aria-hidden="true" />
                  )}
                  <span>{alert}</span>
                  <SourceDisclosure source={lumenAlertSource(summary, index)} />
                </div>
              ))}
            </div>
          </section>

          <PressureTrend summary={summary} />

          <div className="lumen-clinical-grid">
            <section className="lumen-clinical-card">
              <CardTitle icon={<PillIcon size={19} aria-hidden="true" />} title="Medicación activa" />
              {summary.medications.length === 0 ? (
                <span className="lumen-empty-inline">Sin medicación registrada.</span>
              ) : null}
              {summary.medications.map((medication) => (
                <div className="lumen-medication" key={medication}>
                  <span className="lumen-icon-disc">
                    <PillIcon size={20} aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{medication}</strong>
                    <small>Medicación registrada en el expediente sintético</small>
                  </div>
                </div>
              ))}
            </section>

            <section className="lumen-clinical-card">
              <CardTitle icon={<ClipboardCheck size={19} aria-hidden="true" />} title="Últimos exámenes" />
              {summary.recentExams.length === 0 ? (
                <span className="lumen-empty-inline">Sin exámenes recientes.</span>
              ) : null}
              <div className="lumen-exam-list">
                {summary.recentExams.map((exam) => (
                  <div className="lumen-exam-row" key={`${exam.name}-${exam.recordedAt}`}>
                    <Eye size={18} aria-hidden="true" />
                    <span>
                      <strong>{exam.name}</strong>
                      <small>{formatDate(exam.recordedAt)}</small>
                    </span>
                    <SourceDisclosure source={lumenSummarySourceById(summary, exam.sourceId)} />
                  </div>
                ))}
              </div>
            </section>
          </div>

          <Timeline summary={summary} />
        </div>

        <aside className="lumen-patient-rail" aria-label="Contexto clínico del paciente">
          <div className="lumen-profile-avatar" aria-hidden="true">
            {initials(encounter.patientDisplayName)}
          </div>
          <h2>{encounter.patientDisplayName}</h2>
          <p>
            {encounter.patientAge ? `${encounter.patientAge} años` : "Edad no registrada"} ·{" "}
            {encounter.payer ?? "Pagador no registrado"}
          </p>
          <span className="lumen-masked-id">{encounter.documentMasked ?? "Documento enmascarado"}</span>
          <div className="lumen-rail-section">
            <h3>Diagnósticos activos</h3>
            <div className="lumen-tag-list">
              {summary.activeDiagnoses.map((diagnosis) => (
                <span className="lumen-clinical-tag" key={diagnosis}>
                  {diagnosis}
                </span>
              ))}
            </div>
          </div>
          <div className="lumen-rail-section">
            <h3>Motivo registrado</h3>
            <p>{encounter.visitReason ?? "Sin motivo de agenda disponible."}</p>
          </div>
          <div className="lumen-rail-section">
            <h3>Fuentes</h3>
            <div className="lumen-source-list">
              {summary.sources.map((source) => (
                <span key={`${source.label}-${source.recordedAt}`}>
                  <FileText size={15} aria-hidden="true" />
                  <span>
                    <strong>{source.label}</strong>
                    <small>{formatDate(source.recordedAt)}</small>
                  </span>
                </span>
              ))}
            </div>
          </div>
          {canWrite ? (
            <button className="btn btn-primary lumen-rail-primary" type="button" onClick={onStart} disabled={busy}>
              <Mic size={18} aria-hidden="true" /> {actionLabel}
            </button>
          ) : null}
          {detail.clinicalRecord ? (
            <button className="btn btn-outline" type="button" onClick={onOpenRecord}>
              <FileCheck2 size={18} aria-hidden="true" /> Abrir historia clínica
            </button>
          ) : (
            <button className="btn btn-outline" type="button" onClick={onOpenDictation}>
              <AudioLines size={18} aria-hidden="true" /> Ir al dictado
            </button>
          )}
        </aside>
      </div>
      {canWrite ? (
        <div className="lumen-mobile-cta">
          <button className="btn btn-primary" type="button" onClick={onStart} disabled={busy}>
            <Mic size={19} aria-hidden="true" /> {actionLabel}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function DictationView({
  detail,
  draft,
  transcript,
  health,
  audioTransportAllowed,
  action,
  flowState,
  canRetryAudio,
  recording,
  paused,
  seconds,
  stream,
  audioPreview,
  locked,
  onTranscriptChange,
  onStart,
  onPause,
  onStop,
  onCancel,
  onRetryAudio,
  onUpload,
  onStructure
}: {
  detail: LumenEncounterDetail;
  draft?: LumenClinicalRecordContent;
  transcript: string;
  health?: LumenHealth;
  audioTransportAllowed: boolean;
  action?: Action;
  flowState: DictationFlowState;
  canRetryAudio: boolean;
  recording: boolean;
  paused: boolean;
  seconds: number;
  stream: MediaStream | null;
  audioPreview?: Blob;
  locked: boolean;
  onTranscriptChange: (value: string) => void;
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
  onCancel: () => void;
  onRetryAudio: () => void;
  onUpload: (file?: File) => void;
  onStructure: () => void;
}) {
  const latestDictation = detail.dictations[0];
  const fields = detectedFields(draft);
  const providerReady = Boolean(health?.providers.transcriptionConfigured);
  const structurerReady = Boolean(health?.providers.structuringConfigured);
  const cancellable =
    recording ||
    canRetryAudio ||
    action === "processing_audio" ||
    action === "transcribing" ||
    action === "structuring";
  const recordingLabel = paused
    ? "Micrófono en pausa"
    : flowState === "recording"
      ? `Escuchando ${formatDuration(seconds)}`
      : dictationFlowLabel(flowState);

  return (
    <section className="lumen-view" aria-labelledby="dictation-title">
      <ViewTitle
        id="dictation-title"
        eyebrow="Encuentro en curso"
        title="Dictado clínico"
        description={`${detail.encounter.professionalName} · ${detail.encounter.siteName}`}
        trailing={
          <span
            className={`lumen-mic-state state-${flowState}${recording ? " recording" : ""}`}
            data-state={flowState}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <CircleDot size={15} aria-hidden="true" /> {recordingLabel}
          </span>
        }
      />
      <div className="lumen-dictation-layout">
        <div className="lumen-dictation-main">
          <section
            className={`lumen-recorder${recording ? " is-recording" : ""}`}
            aria-label="Captura de audio clínico"
            data-state={flowState}
          >
            <div className="lumen-recorder-heading">
              <span className="lumen-icon-disc">
                <Mic size={21} aria-hidden="true" />
              </span>
              <div>
                <h2>Captura de voz</h2>
                <span>{recordingLabel}</span>
              </div>
              {recording ? <span className="lumen-recording-time">{formatDuration(seconds)}</span> : null}
            </div>
            <LumenWaveform stream={stream} audioBlob={audioPreview} ariaLabel={recordingLabel} />
            <div className="lumen-recorder-controls">
              {recording ? (
                <>
                  <button
                    className="lumen-round-action"
                    type="button"
                    onClick={onPause}
                    aria-label={paused ? "Reanudar grabación" : "Pausar grabación"}
                  >
                    {paused ? <Play size={22} aria-hidden="true" /> : <Pause size={22} aria-hidden="true" />}
                  </button>
                  <button
                    className="lumen-mic-button stop"
                    type="button"
                    onClick={onStop}
                    aria-label="Finalizar grabación"
                  >
                    <Square size={24} aria-hidden="true" />
                  </button>
                </>
              ) : !canRetryAudio ? (
                <button
                  className="lumen-mic-button"
                  type="button"
                  onClick={onStart}
                  disabled={locked || !providerReady || !audioTransportAllowed}
                  aria-label="Iniciar grabación"
                >
                  <Mic size={30} aria-hidden="true" />
                </button>
              ) : null}
              {canRetryAudio ? (
                <button className="btn btn-primary lumen-retry-action" type="button" onClick={onRetryAudio}>
                  <RotateCcw size={17} aria-hidden="true" /> Reintentar audio
                </button>
              ) : null}
              {cancellable ? (
                <button className="btn btn-outline lumen-cancel-action" type="button" onClick={onCancel}>
                  <X size={17} aria-hidden="true" /> {recording || canRetryAudio ? "Descartar" : "Cancelar"}
                </button>
              ) : null}
              <label className={`lumen-upload-action${locked || !audioTransportAllowed ? " disabled" : ""}`}>
                <Upload size={19} aria-hidden="true" />
                <span>Cargar audio autorizado</span>
                <input
                  className="visually-hidden"
                  type="file"
                  accept={LUMEN_ALLOWED_AUDIO_MIME_TYPES.join(",")}
                  capture="user"
                  disabled={locked || !audioTransportAllowed}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    onUpload(file);
                  }}
                />
              </label>
            </div>
            {!audioTransportAllowed ? (
              <div className="lumen-provider-note" role="status">
                <LockKeyhole size={17} aria-hidden="true" />
                <span>
                  <strong>Audio bloqueado en esta conexión.</strong> Usa HTTPS o el túnel local; el transcript manual
                  permanece disponible.
                </span>
              </div>
            ) : !providerReady ? (
              <div className="lumen-provider-note" role="status">
                <AlertTriangle size={17} aria-hidden="true" />
                <span>
                  <strong>Voz sin configurar.</strong> El transcript manual permanece disponible; un audio cargado no se
                  envía.
                </span>
              </div>
            ) : null}
          </section>

          <section className="lumen-transcript-card">
            <div className="lumen-card-heading">
              <div>
                <FileText size={19} aria-hidden="true" />
                <h2>Transcript revisable</h2>
              </div>
              {action === "processing_audio" || action === "transcribing" ? (
                <span className="lumen-processing">
                  <LoaderCircle className="spin" size={15} aria-hidden="true" />
                  {action === "processing_audio" ? "Procesando audio" : "Transcribiendo"}
                </span>
              ) : null}
            </div>
            <label className="visually-hidden" htmlFor="lumen-transcript">
              Transcript clínico
            </label>
            <textarea
              id="lumen-transcript"
              className="lumen-transcript-input"
              value={transcript}
              onChange={(event) => onTranscriptChange(event.target.value)}
              disabled={locked}
              placeholder="Transcript manual"
            />
            <div className="lumen-transcript-meta">
              <TraceSource dictation={latestDictation} />
              <span>
                <FileAudio size={14} aria-hidden="true" /> El audio no se almacena
              </span>
            </div>
          </section>
        </div>

        <aside className="lumen-detected-panel" aria-label="Campos detectados">
          <div className="lumen-card-heading">
            <div>
              <ListChecks size={19} aria-hidden="true" />
              <h2>Campos detectados</h2>
            </div>
            <span className="lumen-field-count">
              {fields.filter((field) => field.value).length}/{fields.length}
            </span>
          </div>
          <div className="lumen-detected-list">
            {fields.map((field) => (
              <DetectedField key={field.key} field={field} />
            ))}
          </div>
          {draft?.uncertainties.length ? (
            <div className="lumen-pending-card">
              <AlertTriangle size={18} aria-hidden="true" />
              <span>
                <strong>{draft.uncertainties.length} pendiente(s) de confirmación</strong>
                <small>La aprobación clínica permanece bloqueada.</small>
              </span>
            </div>
          ) : null}
          <div className="lumen-structure-footer">
            {!structurerReady ? (
              <span className="lumen-provider-inline">
                <AlertTriangle size={15} aria-hidden="true" /> Estructuración sin configurar
              </span>
            ) : null}
            <button
              className="btn btn-primary"
              type="button"
              onClick={onStructure}
              disabled={locked || Boolean(action) || transcript.trim().length < 10 || !structurerReady}
            >
              {action === "structuring" ? (
                <LoaderCircle className="spin" size={17} aria-hidden="true" />
              ) : (
                <Sparkles size={17} aria-hidden="true" />
              )}
              {action === "structuring" ? "Estructurando" : "Estructurar historia clínica"}
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}

function ClinicalRecordView({
  detail,
  draft,
  action,
  locked,
  canWrite,
  onDraftChange,
  onEyeChange,
  onResolveUncertainty,
  onSave,
  onApprove,
  onOpenDictation
}: {
  detail: LumenEncounterDetail;
  draft?: LumenClinicalRecordContent;
  action?: Action;
  locked: boolean;
  canWrite: boolean;
  onDraftChange: (content: LumenClinicalRecordContent) => void;
  onEyeChange: (
    section: "visualAcuity" | "intraocularPressure" | "biomicroscopy" | "gonioscopy" | "fundus",
    eye: "right" | "left",
    value: string
  ) => void;
  onResolveUncertainty: (index: number) => void;
  onSave: () => void;
  onApprove: () => void;
  onOpenDictation: () => void;
}) {
  const record = detail.clinicalRecord;
  if (!draft || !record) {
    return (
      <section className="lumen-view" aria-labelledby="record-title">
        <ViewTitle
          id="record-title"
          eyebrow="Documento clínico"
          title="Historia clínica estructurada"
          description="Sin borrador estructurado"
        />
        <div className="lumen-empty-panel">
          <FileText size={30} aria-hidden="true" />
          <h2>Historia pendiente de estructuración</h2>
          <p>El encuentro conserva el resumen y el transcript disponibles, sin contenido clínico inventado.</p>
          <button className="btn btn-primary" type="button" onClick={onOpenDictation}>
            <Mic size={17} aria-hidden="true" /> Abrir dictado clínico
          </button>
        </div>
      </section>
    );
  }

  const approved = record.status === "approved";
  const blockers = lumenApprovalBlockers(draft);
  const reviewedSections = lumenReviewedSectionCount(draft);
  const latestDictation = detail.dictations.find((entry) => entry.id === record.dictationId) ?? detail.dictations[0];

  return (
    <section className="lumen-view" aria-labelledby="record-title">
      <ViewTitle
        id="record-title"
        eyebrow="Documento clínico"
        title="Historia clínica estructurada"
        description={`Versión ${record.schemaVersion} · ${approved ? "Cerrada" : "Borrador en revisión"}`}
        trailing={<StatusBadge status={approved ? "approved" : "review"} />}
      />

      <div className={`lumen-review-banner${blockers.length ? " warning" : ""}`}>
        {approved ? (
          <LockKeyhole size={21} aria-hidden="true" />
        ) : blockers.length ? (
          <AlertTriangle size={21} aria-hidden="true" />
        ) : (
          <CheckCircle2 size={21} aria-hidden="true" />
        )}
        <div>
          <strong>{approved ? "Historia aprobada e inmutable" : recordOriginLabel(record, latestDictation)}</strong>
          <span>
            {approved
              ? `Aprobada ${record.approvedAt ? formatDateTime(record.approvedAt) : "por acción humana"}`
              : `${reviewedSections} de ${LUMEN_CLINICAL_SECTION_KEYS.length} secciones listas · ${blockers.length} bloqueo(s)`}
          </span>
        </div>
        <div
          className="lumen-review-progress"
          aria-label={`${reviewedSections} de ${LUMEN_CLINICAL_SECTION_KEYS.length} secciones listas`}
        >
          <span style={{ width: `${Math.round((reviewedSections / LUMEN_CLINICAL_SECTION_KEYS.length) * 100)}%` }} />
        </div>
      </div>

      <div className="lumen-record-layout">
        <div className="lumen-record-sections">
          <RecordSection title="Motivo de consulta" index={1} field="reasonForVisit" draft={draft} defaultOpen>
            <label className="lumen-field-label">
              Motivo de consulta
              <textarea
                className="input"
                value={draft.reasonForVisit}
                disabled={locked}
                onChange={(event) => onDraftChange({ ...draft, reasonForVisit: event.target.value })}
              />
            </label>
          </RecordSection>
          <RecordSection title="Evolución e historia" index={2} field="history" draft={draft}>
            <label className="lumen-field-label">
              Evolución documentada
              <textarea
                className="input"
                value={draft.history}
                disabled={locked}
                onChange={(event) => onDraftChange({ ...draft, history: event.target.value })}
              />
            </label>
          </RecordSection>
          <RecordSection title="Agudeza visual" index={3} field="visualAcuity" draft={draft}>
            <EyeEditor
              title="Agudeza visual con corrección"
              value={draft.visualAcuity}
              disabled={locked}
              onChange={(eye, value) => onEyeChange("visualAcuity", eye, value)}
            />
          </RecordSection>
          <RecordSection
            title="Presión intraocular (Goldmann)"
            index={4}
            field="intraocularPressure"
            draft={draft}
            defaultOpen
          >
            <EyeEditor
              title="PIO en mmHg"
              value={draft.intraocularPressure}
              disabled={locked}
              onChange={(eye, value) => onEyeChange("intraocularPressure", eye, value)}
              alertLeft
            />
          </RecordSection>
          <RecordSection title="Biomicroscopía" index={5} field="biomicroscopy" draft={draft}>
            <EyeEditor
              title="Hallazgos por ojo"
              value={draft.biomicroscopy}
              disabled={locked}
              onChange={(eye, value) => onEyeChange("biomicroscopy", eye, value)}
            />
          </RecordSection>
          <RecordSection title="Gonioscopía" index={6} field="gonioscopy" draft={draft} defaultOpen>
            <EyeEditor
              title="Clasificación por ojo"
              value={draft.gonioscopy}
              disabled={locked}
              onChange={(eye, value) => onEyeChange("gonioscopy", eye, value)}
            />
          </RecordSection>
          <RecordSection title="Fondo de ojo" index={7} field="fundus" draft={draft}>
            <EyeEditor
              title="Hallazgos por ojo"
              value={draft.fundus}
              disabled={locked}
              onChange={(eye, value) => onEyeChange("fundus", eye, value)}
            />
          </RecordSection>
          <RecordSection
            title={approved ? "Impresión clínica" : "Impresión clínica sugerida"}
            index={8}
            field="assessment"
            draft={draft}
            defaultOpen
          >
            <div className="lumen-assessment-list">
              {draft.assessment.length === 0 ? (
                <span className="lumen-empty-inline">Sin impresión explícita en el transcript.</span>
              ) : null}
              {draft.assessment.map((entry, index) => (
                <div className="lumen-assessment-row" key={`assessment-${index}`}>
                  <label className="lumen-assessment-code">
                    <span className="visually-hidden">Código de la impresión clínica {index + 1}</span>
                    <input
                      className="input"
                      value={entry.code ?? ""}
                      placeholder="Sin código"
                      maxLength={32}
                      disabled={locked}
                      onChange={(event) => {
                        const assessment = draft.assessment.map((candidate, candidateIndex) =>
                          candidateIndex === index
                            ? { ...candidate, code: event.target.value.trim() || null }
                            : candidate
                        );
                        onDraftChange({ ...draft, assessment });
                      }}
                    />
                  </label>
                  <label className="lumen-assessment-description">
                    <span className="visually-hidden">Descripción de la impresión clínica {index + 1}</span>
                    <input
                      className="input"
                      value={entry.description}
                      required
                      maxLength={2_000}
                      disabled={locked}
                      onChange={(event) => {
                        const assessment = draft.assessment.map((candidate, candidateIndex) =>
                          candidateIndex === index ? { ...candidate, description: event.target.value } : candidate
                        );
                        onDraftChange({ ...draft, assessment });
                      }}
                    />
                    <small>
                      {approved ? "Registrada en la historia aprobada" : "Sugerencia pendiente de criterio profesional"}
                    </small>
                  </label>
                  <ConfidenceBadge confidence={entry.confidence} />
                  {!locked ? (
                    <button
                      className="btn btn-outline btn-sm lumen-assessment-delete"
                      type="button"
                      aria-label={`Eliminar impresión clínica ${index + 1}`}
                      onClick={() => {
                        const assessment = draft.assessment.filter((_, candidateIndex) => candidateIndex !== index);
                        onDraftChange({
                          ...draft,
                          assessment,
                          fieldEvidence:
                            assessment.length === 0
                              ? draft.fieldEvidence.filter((evidence) => evidence.field !== "assessment")
                              : draft.fieldEvidence,
                          uncertainties:
                            assessment.length === 0
                              ? draft.uncertainties.filter((uncertainty) => uncertainty.field !== "assessment")
                              : draft.uncertainties
                        });
                      }}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              ))}
              {!locked ? (
                <button
                  className="btn btn-outline btn-sm lumen-assessment-add"
                  type="button"
                  onClick={() =>
                    onDraftChange({
                      ...draft,
                      assessment: [...draft.assessment, { description: "", code: null, confidence: 1 }]
                    })
                  }
                >
                  <Plus size={16} aria-hidden="true" /> Agregar impresión clínica
                </button>
              ) : null}
            </div>
          </RecordSection>
          <RecordSection title="Plan y órdenes" index={9} field="plan" draft={draft}>
            <label className="lumen-field-label">
              Plan clínico
              <textarea
                className="input"
                value={draft.plan.join("\n")}
                disabled={locked}
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    plan: event.target.value
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean)
                  })
                }
              />
            </label>
          </RecordSection>

          {draft.uncertainties.length > 0 ? (
            <section className="lumen-uncertainty-panel" aria-labelledby="uncertainties-title">
              <div className="lumen-card-heading">
                <div>
                  <AlertTriangle size={19} aria-hidden="true" />
                  <h2 id="uncertainties-title">Pendientes de confirmación</h2>
                </div>
                <span className="lumen-count-warning">{draft.uncertainties.length}</span>
              </div>
              {draft.uncertainties.map((uncertainty, index) => (
                <div className="lumen-uncertainty-row" key={`${uncertainty.field}-${index}`}>
                  <AlertTriangle size={18} aria-hidden="true" />
                  <div>
                    <strong>{fieldLabel(uncertainty.field)}</strong>
                    <span>{uncertainty.message}</span>
                    {uncertainty.sourceText ? <small>Segmento: “{uncertainty.sourceText}”</small> : null}
                  </div>
                  <button
                    className="btn btn-outline btn-sm"
                    type="button"
                    disabled={locked}
                    onClick={() => onResolveUncertainty(index)}
                  >
                    <Check size={15} aria-hidden="true" /> Confirmar dato revisado
                  </button>
                </div>
              ))}
            </section>
          ) : null}
        </div>

        <aside className="lumen-trace-rail">
          <section className="lumen-trace-card">
            <CardTitle icon={<History size={19} aria-hidden="true" />} title="Trazabilidad" />
            <TraceItem
              label="Origen"
              value={dictationSourceLabel(latestDictation)}
              icon={<Mic size={16} aria-hidden="true" />}
            />
            <TraceItem
              label="Transcript"
              value={latestDictation ? formatDateTime(latestDictation.createdAt) : "Entrada manual"}
              icon={<FileAudio size={16} aria-hidden="true" />}
            />
            <TraceItem
              label="Estructuración"
              value={
                record.provider && record.model
                  ? `${record.provider} · ${record.model}`
                  : "Escenario sintético · sin proveedor"
              }
              icon={<Sparkles size={16} aria-hidden="true" />}
            />
            <TraceItem
              label="Última revisión"
              value={formatDateTime(record.updatedAt)}
              icon={<BookOpenCheck size={16} aria-hidden="true" />}
            />
          </section>
          <section className={`lumen-approval-card${blockers.length ? " blocked" : ""}`}>
            <CardTitle icon={<ShieldCheck size={19} aria-hidden="true" />} title="Aprobación clínica" />
            {approved ? (
              <div className="lumen-approved-state">
                <CheckCircle2 size={28} aria-hidden="true" />
                <strong>Aprobada por acción humana</strong>
                <span>Documento cerrado e inmutable.</span>
              </div>
            ) : (
              <>
                {blockers.length ? (
                  <div className="lumen-blocker-list">
                    {blockers.map((blocker) => (
                      <span key={blocker}>
                        <LockKeyhole size={14} aria-hidden="true" /> {blocker}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="lumen-ready-state">
                    <CheckCircle2 size={18} aria-hidden="true" /> Lista para aprobación profesional
                  </div>
                )}
                {canWrite ? (
                  <>
                    <button className="btn btn-outline" type="button" onClick={onSave} disabled={Boolean(action)}>
                      <Save size={17} aria-hidden="true" /> {action === "saving" ? "Guardando" : "Guardar borrador"}
                    </button>
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={onApprove}
                      disabled={Boolean(action) || blockers.length > 0}
                    >
                      <ShieldCheck size={17} aria-hidden="true" />{" "}
                      {action === "approving" ? "Aprobando" : "Aprobar y cerrar HC"}
                    </button>
                  </>
                ) : (
                  <Pill tone="blue">Rol de solo lectura</Pill>
                )}
              </>
            )}
          </section>
        </aside>
      </div>
      {!approved && canWrite ? (
        <div className="lumen-mobile-cta lumen-record-mobile-actions">
          <button className="btn btn-outline" type="button" onClick={onSave} disabled={Boolean(action)}>
            <Save size={17} aria-hidden="true" /> Guardar
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={onApprove}
            disabled={Boolean(action) || blockers.length > 0}
          >
            <ShieldCheck size={17} aria-hidden="true" /> Aprobar HC
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ViewTitle({
  id,
  eyebrow,
  title,
  description,
  trailing
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  trailing?: ReactNode;
}) {
  return (
    <header className="lumen-view-title">
      <div>
        <span className="lumen-eyebrow">{eyebrow}</span>
        <h1 id={id}>{title}</h1>
        <p>{description}</p>
      </div>
      {trailing ? <div className="lumen-view-trailing">{trailing}</div> : null}
    </header>
  );
}

function CardTitle({ icon, title, id }: { icon: ReactNode; title: string; id?: string }) {
  return (
    <div className="lumen-section-title">
      {icon}
      <h2 id={id}>{title}</h2>
    </div>
  );
}

function PressureTrend({ summary }: { summary: LumenPreconsultationSummary }) {
  const trends = summary.trends.filter((trend) => trend.points.length > 0);
  if (trends.length === 0) {
    return (
      <section className="lumen-trend-card">
        <CardTitle icon={<Activity size={19} aria-hidden="true" />} title="Tendencia clínica" />
        <span className="lumen-empty-inline">Sin mediciones históricas.</span>
      </section>
    );
  }
  const width = 720;
  const height = 230;
  const padX = 48;
  const padTop = 28;
  const padBottom = 44;
  const { min: minValue, max: maxValue } = lumenTrendDomain(trends);
  const dates = [...new Set(trends.flatMap((trend) => trend.points.map((point) => point.recordedAt)))].sort(
    (left, right) => new Date(left).getTime() - new Date(right).getTime()
  );
  const x = (recordedAt: string) => {
    const index = Math.max(0, dates.indexOf(recordedAt));
    return padX + (index * (width - padX * 2)) / Math.max(1, dates.length - 1);
  };
  const y = (value: number) => padTop + ((maxValue - value) * (height - padTop - padBottom)) / (maxValue - minValue);
  const ticks = [...new Set([minValue, Math.round((minValue + maxValue) / 2), maxValue])];
  const ariaDescription = trends
    .map((trend) => `${trend.label}: ${trend.points.map((point) => point.value).join(", ")} ${trend.unit}`)
    .join(". ");
  return (
    <section className="lumen-trend-card" aria-labelledby="pressure-trend-title">
      <div className="lumen-card-heading">
        <div>
          <Activity size={19} aria-hidden="true" />
          <h2 id="pressure-trend-title">PIO histórica OD/OI</h2>
        </div>
        <span className="lumen-target-label">Metas por ojo</span>
      </div>
      <div className="lumen-trend-legend" aria-label="Series y metas clínicas">
        {trends.map((trend, index) => (
          <span key={trend.label}>
            <i className={`series-${index % 2}`} aria-hidden="true" />
            <strong>{trend.label}</strong>
            {lumenTrendTargetLabel(trend) ? <small>Meta {lumenTrendTargetLabel(trend)}</small> : null}
          </span>
        ))}
      </div>
      <svg className="lumen-trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaDescription}>
        {trends.map((trend, index) => {
          const targetMin = trend.targetMin;
          const targetMax = trend.targetMax;
          if (targetMin == null || targetMax == null || targetMax < targetMin) return null;
          return (
            <rect
              key={`target-band-${trend.label}`}
              x={padX}
              y={y(targetMax)}
              width={width - padX * 2}
              height={Math.max(1, y(targetMin) - y(targetMax))}
              className={`lumen-chart-band series-${index % 2}`}
            />
          );
        })}
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={padX} x2={width - padX} y1={y(tick)} y2={y(tick)} className="lumen-chart-grid" />
            <text x={padX - 12} y={y(tick) + 5} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}
        {trends.flatMap((trend, index) =>
          [trend.targetMin, trend.targetMax]
            .filter((target): target is number => target != null)
            .map((target, targetIndex) => (
              <line
                key={`target-${trend.label}-${targetIndex}`}
                x1={padX}
                x2={width - padX}
                y1={y(target)}
                y2={y(target)}
                className={`lumen-chart-target series-${index % 2}`}
              />
            ))
        )}
        {trends.map((trend, index) => (
          <polyline
            key={`line-${trend.label}`}
            points={trend.points.map((point) => `${x(point.recordedAt)},${y(point.value)}`).join(" ")}
            className={`lumen-chart-line series-${index % 2}`}
          />
        ))}
        {trends.flatMap((trend, trendIndex) =>
          trend.points.map((point) => {
            const outsideTarget =
              (trend.targetMin != null && point.value < trend.targetMin) ||
              (trend.targetMax != null && point.value > trend.targetMax);
            return (
              <g key={`${trend.label}-${point.recordedAt}-${point.value}`}>
                <circle
                  cx={x(point.recordedAt)}
                  cy={y(point.value)}
                  r="6"
                  className={`lumen-chart-point series-${trendIndex % 2}${outsideTarget ? " alert" : ""}`}
                />
                <text
                  x={x(point.recordedAt)}
                  y={y(point.value) - 13 - trendIndex * 3}
                  textAnchor="middle"
                  className={`lumen-chart-value series-${trendIndex % 2}`}
                >
                  {point.value}
                </text>
              </g>
            );
          })
        )}
        {dates.map((recordedAt) => (
          <text
            key={`date-${recordedAt}`}
            x={x(recordedAt)}
            y={height - 14}
            textAnchor="middle"
            className="lumen-chart-date"
          >
            {formatChartDate(recordedAt)}
          </text>
        ))}
      </svg>
    </section>
  );
}

function Timeline({ summary }: { summary: LumenPreconsultationSummary }) {
  return (
    <section className="lumen-timeline" aria-labelledby="timeline-title">
      <CardTitle icon={<History size={19} aria-hidden="true" />} title="Historia de controles" id="timeline-title" />
      {summary.timeline.length === 0 ? <span className="lumen-empty-inline">Sin hitos históricos.</span> : null}
      <div className="lumen-timeline-track">
        {summary.timeline.map((entry, index) => (
          <div className="lumen-timeline-item" key={`${entry.recordedAt}-${entry.title}`}>
            <span className="lumen-timeline-dot" aria-hidden="true" />
            <small>{formatDate(entry.recordedAt)}</small>
            <strong>{entry.title}</strong>
            <span>{entry.detail}</span>
            <SourceDisclosure source={lumenSummarySourceById(summary, entry.sourceId)} compact />
            {index < summary.timeline.length - 1 ? <i aria-hidden="true" /> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceDisclosure({ source, compact = false }: { source?: LumenSummarySource; compact?: boolean }) {
  if (!source) return null;
  return (
    <details className={`lumen-source-disclosure${compact ? " compact" : ""}`}>
      <summary aria-label={`Ver fuente: ${source.label}`}>
        <ShieldCheck size={13} aria-hidden="true" /> Fuente
      </summary>
      <div>
        <strong>{source.label}</strong>
        <time dateTime={source.recordedAt}>{formatDate(source.recordedAt)}</time>
        {source.detail ? <span>{source.detail}</span> : null}
      </div>
    </details>
  );
}

interface DetectedFieldModel {
  key: string;
  label: string;
  value: string | null;
  confidence?: number;
  pending: boolean;
  alert?: boolean;
}

function detectedFields(draft?: LumenClinicalRecordContent): DetectedFieldModel[] {
  if (!draft)
    return [
      { key: "visualAcuity.right", label: "AV OD", value: null, pending: false },
      { key: "visualAcuity.left", label: "AV OI", value: null, pending: false },
      { key: "intraocularPressure.right", label: "PIO OD", value: null, pending: false },
      { key: "intraocularPressure.left", label: "PIO OI", value: null, pending: false },
      { key: "gonioscopy.left", label: "Gonioscopía OI", value: null, pending: false },
      { key: "assessment", label: "Dx sugerido", value: null, pending: false }
    ];
  const evidence = (key: string) => draft.fieldEvidence.find((entry) => entry.field === key);
  const pending = (key: string) =>
    draft.uncertainties.some((entry) => entry.field === key || entry.field.startsWith(key.split(".")[0]!));
  const value = (key: string, label: string, raw: string | null, alert = false): DetectedFieldModel => ({
    key,
    label,
    value: raw,
    confidence: evidence(key)?.confidence,
    pending: pending(key) || Boolean(evidence(key) && evidence(key)!.confidence < 0.85),
    alert
  });
  const pressureLeft = draft.intraocularPressure.left;
  const pressureValue = Number.parseFloat(pressureLeft?.replace(",", ".") ?? "");
  return [
    value("visualAcuity.right", "AV OD", draft.visualAcuity.right),
    value("visualAcuity.left", "AV OI", draft.visualAcuity.left),
    value("intraocularPressure.right", "PIO OD", draft.intraocularPressure.right),
    value("intraocularPressure.left", "PIO OI", pressureLeft, Number.isFinite(pressureValue) && pressureValue > 18),
    value("gonioscopy.left", "Gonioscopía OI", draft.gonioscopy.left),
    {
      key: "assessment",
      label: "Dx sugerido",
      value:
        draft.assessment.map((entry) => `${entry.code ? `${entry.code} · ` : ""}${entry.description}`).join("; ") ||
        null,
      confidence:
        evidence("assessment")?.confidence ??
        (draft.assessment.length ? Math.min(...draft.assessment.map((entry) => entry.confidence)) : undefined),
      pending: pending("assessment")
    }
  ];
}

function DetectedField({ field }: { field: DetectedFieldModel }) {
  const tone = field.alert ? "alert" : field.pending ? "pending" : field.value ? "ready" : "empty";
  return (
    <div className={`lumen-detected-field ${tone}`}>
      <span className="lumen-field-icon">
        {field.alert ? (
          <AlertCircle size={19} aria-hidden="true" />
        ) : field.value ? (
          <CheckCircle2 size={19} aria-hidden="true" />
        ) : (
          <CircleDot size={19} aria-hidden="true" />
        )}
      </span>
      <div className="lumen-field-value">
        <small>{field.label}</small>
        <strong>{field.value ?? "Pendiente"}</strong>
        {field.alert ? <span>Sobre meta clínica registrada</span> : null}
      </div>
      <div className="lumen-confidence-cell">
        <span>{field.confidence === undefined ? "Sin confianza" : `${Math.round(field.confidence * 100)} %`}</span>
        <i>
          <b style={{ width: field.confidence === undefined ? "0" : `${Math.round(field.confidence * 100)}%` }} />
        </i>
        <small>{field.pending ? "Confirmar" : field.value ? "Detectado" : "Sin dato"}</small>
      </div>
    </div>
  );
}

function TraceSource({ dictation }: { dictation?: LumenDictation }) {
  if (!dictation)
    return (
      <span>
        <FileText size={14} aria-hidden="true" /> Entrada manual sin proveedor
      </span>
    );
  if (dictation.source === "synthetic_demo")
    return (
      <span>
        <ShieldCheck size={14} aria-hidden="true" /> Guion sintético · no es transcripción real
      </span>
    );
  return (
    <span>
      <ShieldCheck size={14} aria-hidden="true" /> {dictation.provider ?? "Proveedor no informado"} ·{" "}
      {dictation.model ?? "Modelo no informado"} · {dictationSourceLabel(dictation)}
    </span>
  );
}

function RecordSection({
  title,
  index,
  field,
  draft,
  defaultOpen,
  children
}: {
  title: string;
  index: number;
  field: string;
  draft: LumenClinicalRecordContent;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const evidence = draft.fieldEvidence.filter((entry) => entry.field === field || entry.field.startsWith(`${field}.`));
  const confidence = evidence.length ? Math.min(...evidence.map((entry) => entry.confidence)) : undefined;
  const pending = draft.uncertainties.some((entry) => entry.field === field || entry.field.startsWith(`${field}.`));
  const hasValue = lumenSectionHasValue(draft, field as (typeof LUMEN_CLINICAL_SECTION_KEYS)[number]);
  return (
    <details className={`lumen-record-section${pending ? " pending" : ""}`} open={defaultOpen || undefined}>
      <summary>
        <span className={`lumen-section-state${pending ? " pending" : hasValue ? "ready" : "empty"}`}>
          {pending ? (
            <AlertTriangle size={17} aria-hidden="true" />
          ) : hasValue ? (
            <Check size={17} aria-hidden="true" />
          ) : (
            <CircleDot size={17} aria-hidden="true" />
          )}
        </span>
        <span className="lumen-section-index">{index}</span>
        <span className="lumen-section-label">
          <strong>{title}</strong>
          <small>{pending ? "Requiere confirmación" : hasValue ? "Con datos trazables" : "Sin dato registrado"}</small>
        </span>
        {confidence !== undefined ? (
          <ConfidenceBadge confidence={confidence} compact />
        ) : (
          <span className="lumen-no-confidence">Sin confianza reportada</span>
        )}
        <ChevronDown className="lumen-details-chevron" size={18} aria-hidden="true" />
      </summary>
      <div className="lumen-section-content">
        {children}
        {evidence.length ? (
          <div className="lumen-evidence-list">
            {evidence.map((entry) => (
              <span key={`${entry.field}-${entry.sourceText ?? ""}`}>
                <ShieldCheck size={14} aria-hidden="true" /> {fieldLabel(entry.field)} ·{" "}
                {Math.round(entry.confidence * 100)} % · {evidenceOriginLabel(entry.origin)}
                {entry.sourceText ? ` · “${entry.sourceText}”` : ""}
              </span>
            ))}
          </div>
        ) : (
          <span className="lumen-evidence-empty">
            <Info size={14} aria-hidden="true" /> El proveedor no reportó evidencia para esta sección.
          </span>
        )}
      </div>
    </details>
  );
}

function EyeEditor({
  title,
  value,
  disabled,
  onChange,
  alertLeft
}: {
  title: string;
  value: { right: string | null; left: string | null };
  disabled: boolean;
  onChange: (eye: "right" | "left", value: string) => void;
  alertLeft?: boolean;
}) {
  return (
    <fieldset className="lumen-eye-editor">
      <legend>{title}</legend>
      <label>
        <span>
          OD <small>Ojo derecho</small>
        </span>
        <input
          className="input"
          value={value.right ?? ""}
          disabled={disabled}
          onChange={(event) => onChange("right", event.target.value)}
        />
      </label>
      <label className={alertLeft ? "clinical-alert" : undefined}>
        <span>
          OI <small>Ojo izquierdo</small>
        </span>
        <input
          className="input"
          value={value.left ?? ""}
          disabled={disabled}
          onChange={(event) => onChange("left", event.target.value)}
        />
        {alertLeft ? (
          <em>
            <AlertTriangle size={14} aria-hidden="true" /> Revisar contra meta
          </em>
        ) : null}
      </label>
    </fieldset>
  );
}

function ConfidenceBadge({ confidence, compact }: { confidence: number; compact?: boolean }) {
  const pending = confidence < 0.85;
  return (
    <span className={`lumen-confidence-badge${pending ? " pending" : ""}${compact ? " compact" : ""}`}>
      <span>{Math.round(confidence * 100)} %</span>
      {!compact ? <small>{pending ? "Confirmar" : "Confianza reportada"}</small> : null}
    </span>
  );
}

function TraceItem({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="lumen-trace-item">
      <span className="lumen-trace-icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: LumenWorklistEntry["status"] }) {
  const tone =
    status === "approved"
      ? "approved"
      : status === "review"
        ? "review"
        : status === "in_progress"
          ? "progress"
          : "scheduled";
  return (
    <span className={`lumen-status-badge ${tone}`}>
      {status === "approved" ? (
        <CheckCircle2 size={13} aria-hidden="true" />
      ) : status === "review" ? (
        <ListChecks size={13} aria-hidden="true" />
      ) : status === "in_progress" ? (
        <Mic size={13} aria-hidden="true" />
      ) : (
        <Clock3 size={13} aria-hidden="true" />
      )}
      {statusLabel(status)}
    </span>
  );
}

function currentLumenAudioTransportAllowed(): boolean {
  return isLumenAudioTransportAllowed({
    hostname: window.location.hostname,
    protocol: window.location.protocol,
    isSecureContext: window.isSecureContext
  });
}

async function blobToBase64(blob: Blob, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(binary);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function lumenIdempotencyFailure(error: unknown): LumenIdempotencyFailure {
  if (isAbortError(error)) return { kind: "abort" };
  if (error instanceof ApiError) return { kind: "api", status: error.status, message: error.message };
  return { kind: "transport" };
}

function lumenAudioValidationMessage(code?: LumenAudioValidationCode): string {
  if (code === "invalid_size") return "El audio debe pesar entre 1 byte y 5 MiB.";
  if (code === "invalid_duration") return "El audio debe durar entre 1 y 90 segundos.";
  return "Formato de audio no permitido. Usa WebM, OGG, WAV, MP3, MP4/M4A o AAC.";
}

function dictationFlowLabel(state: DictationFlowState): string {
  return {
    ready: "Listo para grabar",
    recording: "Grabando",
    processing_audio: "Procesando audio",
    transcribing: "Transcribiendo audio",
    structuring: "Estructurando historia",
    completed: "Proceso completado",
    recoverable_error: "Error recuperable",
    not_configured: "Proveedor no configurado"
  }[state];
}

function statusLabel(status: LumenWorklistEntry["status"]): string {
  return { preconsultation: "Preconsulta", in_progress: "En consulta", review: "En revisión", approved: "Aprobada" }[
    status
  ];
}

function dictationSourceLabel(dictation?: LumenDictation): string {
  if (!dictation) return "Entrada manual";
  return {
    browser_microphone: "Micrófono del navegador",
    authorized_upload: "Carga autorizada",
    manual_entry: "Transcript manual",
    synthetic_demo: "Guion sintético precargado"
  }[dictation.source];
}

function recordOriginLabel(record: LumenClinicalRecord, dictation?: LumenDictation): string {
  if (!record.provider || !record.model) return "Borrador sintético · revisión humana obligatoria";
  return `Estructurada por ${record.provider} · revisión humana obligatoria${dictation ? ` · ${dictationSourceLabel(dictation)}` : ""}`;
}

function evidenceOriginLabel(origin: LumenClinicalRecordContent["fieldEvidence"][number]["origin"]): string {
  return {
    voice: "voz",
    voice_reviewed: "voz revisada",
    manual: "entrada manual",
    synthetic_demo: "guion sintético"
  }[origin];
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    reasonForVisit: "Motivo de consulta",
    history: "Evolución",
    visualAcuity: "Agudeza visual",
    "visualAcuity.right": "AV OD",
    "visualAcuity.left": "AV OI",
    intraocularPressure: "Presión intraocular",
    "intraocularPressure.right": "PIO OD",
    "intraocularPressure.left": "PIO OI",
    biomicroscopy: "Biomicroscopía",
    gonioscopy: "Gonioscopía",
    "gonioscopy.right": "Gonioscopía OD",
    "gonioscopy.left": "Gonioscopía OI",
    fundus: "Fondo de ojo",
    assessment: "Impresión clínica",
    plan: "Plan"
  };
  return labels[field] ?? field;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter((part) => part && part !== "·" && part.toLowerCase() !== "demo")
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "DE"
  );
}

function encounterHref(pathname: string, encounterId?: string): string {
  const base = resolveLumenLocation({ pathname })?.pathname ?? "/lumen/preconsulta";
  return encounterId ? `${base}?encounter=${encodeURIComponent(encounterId)}` : base;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" }).format(
    new Date(value)
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(value)
  );
}

function formatChartDate(value: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC"
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Bogota"
  }).format(new Date(value));
}

function formatDuration(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
