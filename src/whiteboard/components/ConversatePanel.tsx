import { useEffect, useRef, useState, useCallback } from "react";

type Line = { id: number; role: "user" | "ai"; text: string };
type State = "idle" | "connecting" | "live" | "error";

let _lineId = 0;

export function ConversatePanel() {
  const [state, setState] = useState<State>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
    }
    tick();
    return () => cancelAnimationFrame(rafRef.current);
  }, [state]);

  async function connect() {
    setState("connecting");
    setErrorMsg("");
    setLines([]);

    try {
      // 1. Get ephemeral token
      const res = await fetch("/api/realtime-session", { method: "POST" });
      const session = await res.json() as { client_secret?: { value?: string }; error?: string };
      if (!res.ok) throw new Error(session.error ?? `Session failed (${res.status})`);
      const token = session?.client_secret?.value;
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
      pc.addTrack(mic.getAudioTracks()[0], mic);

      // Mic analyser for speaking detection
      const actx = new AudioContext();
      const analyser = actx.createAnalyser();
      analyser.fftSize = 128;
      actx.createMediaStreamSource(mic).connect(analyser);
      analyserRef.current = analyser;

      // 5. Data channel
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        // Enable transcription for user mic
        dc.send(JSON.stringify({
          type: "session.update",
          session: { input_audio_transcription: { model: "whisper-1" } },
        }));
      };

      dc.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data as string) as { type: string; delta?: string; transcript?: string };
          if (ev.type === "response.audio_transcript.delta" && ev.delta) {
            pushLine("ai", ev.delta);
            setAiSpeaking(true);
          }
          if (ev.type === "response.audio_transcript.done") setAiSpeaking(false);
          if (ev.type === "conversation.item.input_audio_transcription.completed" && ev.transcript) {
            pushLine("user", ev.transcript);
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
        "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
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
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
      pcRef.current?.close();
      pcRef.current = null;
    }
  }

  function disconnect() {
    cancelAnimationFrame(rafRef.current);
    dcRef.current?.close();
    pcRef.current?.close();
    if (audioRef.current) { audioRef.current.srcObject = null; }
    pcRef.current = null;
    dcRef.current = null;
    analyserRef.current = null;
    setAiSpeaking(false);
    setUserSpeaking(false);
    setState("idle");
  }

  const isLive = state === "live";
  const speaking = aiSpeaking || userSpeaking;

  return (
    <div className="cv-panel">
      {/* Orb */}
      <div className="cv-orb-area">
        <div className={`cv-orb ${isLive ? "cv-orb--live" : ""} ${speaking ? "cv-orb--speaking" : ""}`}>
          <div className="cv-orb-ring cv-orb-ring--1" />
          <div className="cv-orb-ring cv-orb-ring--2" />
          <div className="cv-orb-ring cv-orb-ring--3" />
          <div className="cv-orb-core">
            {!isLive && <span className="cv-orb-icon">◎</span>}
            {isLive && aiSpeaking && <span className="cv-orb-icon">▶</span>}
            {isLive && userSpeaking && !aiSpeaking && <span className="cv-orb-icon">◉</span>}
            {isLive && !aiSpeaking && !userSpeaking && <span className="cv-orb-icon">◎</span>}
          </div>
        </div>
        <p className="cv-status-label">
          {state === "idle" && "Ready to connect"}
          {state === "connecting" && "Connecting…"}
          {state === "live" && aiSpeaking && "AI speaking"}
          {state === "live" && userSpeaking && !aiSpeaking && "Listening…"}
          {state === "live" && !aiSpeaking && !userSpeaking && "Live · say something"}
          {state === "error" && errorMsg}
        </p>
      </div>

      {/* Controls */}
      <div className="cv-controls">
        {state !== "live" && (
          <button
            className="cv-btn cv-btn--connect"
            onClick={connect}
            disabled={state === "connecting"}
          >
            {state === "connecting" ? "Connecting…" : state === "error" ? "Retry" : "Start"}
          </button>
        )}
        {state === "live" && (
          <button className="cv-btn cv-btn--end" onClick={disconnect}>End</button>
        )}
      </div>

      {/* Transcript */}
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
