import { useEffect, useRef, useState, useCallback } from "react";
import { VoiceOrb } from "./VoiceOrb.js";
import type { OrbState } from "./VoiceOrb.js";

type Line = { id: number; role: "user" | "ai"; text: string };
type State = "idle" | "connecting" | "live" | "error";

let _lineId = 0;

export function ConversatePanel() {
  const [state, setState] = useState<State>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pushLine = useCallback((role: "user" | "ai", text: string) => {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { id: _lineId++, role, text }];
    });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  // Track mic energy for speaking indicator
  useEffect(() => {
    if (!analyserRef.current) return;
    const data = new Uint8Array(64);
    function tick() {
      rafRef.current = requestAnimationFrame(tick);
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      setUserSpeaking(avg > 18);
      setAudioLevel(Math.min(1, avg / 96));
    }
    tick();
    return () => cancelAnimationFrame(rafRef.current);
  }, [state]);

  const cleanupRealtime = useCallback((resetVisuals = true) => {
    cancelAnimationFrame(rafRef.current);
    dcRef.current?.close();
    pcRef.current?.close();
    if (audioRef.current) audioRef.current.srcObject = null;
    micRef.current?.getTracks().forEach((track) => track.stop());
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close().catch(() => undefined);
    }
    pcRef.current = null;
    dcRef.current = null;
    micRef.current = null;
    audioContextRef.current = null;
    analyserRef.current = null;
    if (resetVisuals) {
      setAiSpeaking(false);
      setUserSpeaking(false);
      setAudioLevel(0);
    }
  }, []);

  useEffect(() => () => cleanupRealtime(false), [cleanupRealtime]);

  async function connect() {
    cleanupRealtime();
    setState("connecting");
    setErrorMsg("");
    setLines([]);

    try {
      if (!window.isSecureContext) {
        throw new Error("Microphone access requires localhost or HTTPS.");
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access is unavailable in this browser.");
      }

      // 1. Get ephemeral token
      const res = await fetch("/api/realtime-session", { method: "POST" });
      const session = await res.json() as { value?: string; client_secret?: { value?: string }; error?: unknown };
      if (!res.ok) {
        const e = session.error;
        const msg = typeof e === "string" ? e
          : (e && typeof e === "object" && "message" in e) ? String((e as { message: unknown }).message)
          : `Session failed (${res.status})`;
        throw new Error(msg);
      }
      const token = session?.value ?? session?.client_secret?.value;
      if (!token) throw new Error("No ephemeral token in response");

      // 2. Peer connection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // 3. Model audio output
      const audio = new Audio();
      audio.autoplay = true;
      audioRef.current = audio;
      pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };

      // 4. Mic input
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micRef.current = mic;
      pc.addTrack(mic.getAudioTracks()[0], mic);

      // Mic analyser for speaking detection
      const actx = new AudioContext();
      audioContextRef.current = actx;
      const analyser = actx.createAnalyser();
      analyser.fftSize = 128;
      actx.createMediaStreamSource(mic).connect(analyser);
      analyserRef.current = analyser;

      // 5. Data channel
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data as string) as {
            type: string;
            delta?: string;
            transcript?: string;
            error?: { message?: string };
          };
          if ((ev.type === "response.output_audio.delta" || ev.type === "response.audio.delta") && ev.delta) {
            setAiSpeaking(true);
          }
          if ((ev.type === "response.output_audio_transcript.delta" || ev.type === "response.audio_transcript.delta") && ev.delta) {
            pushLine("ai", ev.delta);
            setAiSpeaking(true);
          }
          if (
            ev.type === "response.output_audio.done" ||
            ev.type === "response.audio.done" ||
            ev.type === "response.output_audio_transcript.done" ||
            ev.type === "response.audio_transcript.done"
          ) setAiSpeaking(false);
          if (ev.type === "conversation.item.input_audio_transcription.completed" && ev.transcript) {
            pushLine("user", ev.transcript);
          }
          if (ev.type === "error") {
            setErrorMsg(ev.error?.message ?? "Realtime error");
          }
        } catch { /* ignore */ }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          setState("error");
          setErrorMsg("Connection lost");
        }
      };

      // 6. SDP offer → OpenAI → answer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpRes = await fetch(
        "https://api.openai.com/v1/realtime/calls",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/sdp" },
          body: offer.sdp,
        }
      );
      if (!sdpRes.ok) {
        const errText = await sdpRes.text();
        throw new Error(`SDP exchange failed (${sdpRes.status}): ${errText.slice(0, 120)}`);
      }
      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setState("live");
    } catch (err) {
      cleanupRealtime();
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  function disconnect() {
    cleanupRealtime();
    setState("idle");
  }

  const isLive = state === "live";
  const orbState: OrbState = state === "connecting" ? "thinking"
    : !isLive ? "idle"
    : aiSpeaking ? "speaking"
    : userSpeaking ? "listening"
    : "thinking";
  const statusText = state === "connecting" ? "Connecting..."
    : state === "live" && aiSpeaking ? "Speaking..."
    : state === "live" && userSpeaking && !aiSpeaking ? "Listening..."
    : state === "error" ? errorMsg
    : "";

  return (
    <div className="cv-panel">
      <div className="cv-orb-area">
        <VoiceOrb state={orbState} audioLevel={audioLevel} size={500} />
        {statusText && <p className="cv-status-label">{statusText}</p>}
      </div>

      <div className="cv-controls">
        {state !== "live" && (
          <button
            className="cv-btn cv-btn--connect"
            onClick={connect}
            disabled={state === "connecting"}
          >
            {state === "connecting" ? "Connecting…" : state === "error" ? "Try again" : "Start"}
          </button>
        )}
        {state === "live" && (
          <button className="cv-btn cv-btn--end" onClick={disconnect}>End</button>
        )}
      </div>

      {lines.length > 0 && (
        <div className="cv-transcript" ref={scrollRef}>
          {lines.map((l) => (
            <div key={l.id} className={`cv-line cv-line--${l.role}`}>
              <span className="cv-line-who">{l.role === "user" ? "You" : "AI"}</span>
              <span className="cv-line-text">{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
