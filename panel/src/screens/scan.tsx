/** QR attendance: pick a lesson, then scan cards with the camera (or type a code from a USB reader). */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { components } from "@api/schema";
import { api, newKey, unwrap } from "../api/client";
import type { ApiFailure } from "../api/errors";
import { useI18n } from "../i18n";
import { formatTime } from "../lib/format";
import { useStaff } from "../session/context";
import { asFailure, useLoad } from "../ui/hooks";
import { ErrorNote, Loaded, Page } from "../ui/kit";
import { RollCall } from "./lessons";

type Scan = components["schemas"]["ScanOut"];
const SAME_CODE_PAUSE_MS = 4000;
const FRAME_MS = 200;

interface BarcodeDetectorLike {
  detect(source: HTMLCanvasElement): Promise<{ rawValue: string }[]>;
}

/** Reads QR codes from the camera until it is switched off. The video stays in the browser: only the code is sent. */
function useCamera(onCode: (code: string) => void) {
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  const handler = useRef(onCode);
  handler.current = onCode;
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const canvas = document.createElement("canvas");
    const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
    let detector: BarcodeDetectorLike | null = null;
    try {
      detector = Detector ? new Detector({ formats: ["qr_code"] }) : null;
    } catch {
      detector = null;
    }
    const tick = async () => {
      const element = video.current;
      if (stopped) return;
      if (element && element.videoWidth) {
        canvas.width = element.videoWidth;
        canvas.height = element.videoHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(element, 0, 0);
        let found: string | undefined;
        if (detector) {
          found = await detector.detect(canvas).then(
            (codes) => codes[0]?.rawValue,
            () => {
              detector = null; // this browser's detector does not work: use the bundled reader from now on
              return undefined;
            },
          );
        }
        if (!detector) {
          const { default: jsQR } = await import("jsqr"); // loaded only where the browser has no detector of its own
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          found = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data;
        }
        if (found && !stopped) handler.current(found);
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), FRAME_MS);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(async (media) => {
        if (stopped) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        video.current!.srcObject = media;
        await video.current!.play();
        void tick();
      })
      .catch(() => {
        setFailed(true);
        setOn(false);
      });
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [on]);
  return { video, on, failed, toggle: () => { setFailed(false); setOn((v) => !v); } };
}

export function ScanPage() {
  const { t, label } = useI18n();
  const { today } = useStaff();
  const [day, setDay] = useState(today);
  const lessons = useLoad(
    async () => (await unwrap(api.GET("/v1/calendar", { params: { query: { date: day, view: "day" } } }))).days.flatMap((d) => d.entries).filter((e) => e.status !== "cancelled"),
    [day],
  );
  const [lesson, setLesson] = useState("");
  const [code, setCode] = useState("");
  const [log, setLog] = useState<{ id: number; scan?: Scan; error?: ApiFailure }[]>([]);
  const [turn, setTurn] = useState(0);
  const busy = useRef(false);
  const recent = useRef({ code: "", at: 0 });
  const counter = useRef(0);

  const send = useCallback(
    async (value: string) => {
      if (!lesson || busy.current) return;
      busy.current = true;
      const id = ++counter.current;
      try {
        const scan = await unwrap(
          api.POST("/v1/attendance/scan", { body: { code: value, lesson_id: lesson }, headers: { "Idempotency-Key": newKey() } }),
        );
        setLog((all) => [{ id, scan }, ...all].slice(0, 20));
        setTurn((n) => n + 1);
      } catch (error) {
        setLog((all) => [{ id, error: asFailure(error) }, ...all].slice(0, 20));
      } finally {
        busy.current = false;
      }
    },
    [lesson],
  );

  const camera = useCamera((value) => {
    const now = Date.now();
    if (value === recent.current.code && now - recent.current.at < SAME_CODE_PAUSE_MS) return; // the card is still in view
    recent.current = { code: value, at: now };
    void send(value);
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (!value) return;
    setCode("");
    void send(value);
  };

  return (
    <Page title={t("nav.scan")}>
      <div className="filters">
        <label>
          {t("common.date")}
          <input
            type="date"
            value={day}
            onChange={(e) => {
              if (!e.target.value) return;
              setDay(e.target.value);
              setLesson("");
              setLog([]);
            }}
          />
        </label>
        <Loaded load={lessons}>
          {(rows) => (
            <label>
              {t("lessons.one")}
              <select
                value={lesson}
                onChange={(e) => {
                  setLesson(e.target.value);
                  setLog([]);
                }}
              >
                <option value="">{rows.length ? t("common.choose") : t("calendar.noLessons")}</option>
                {rows.map((r) => (
                  <option key={r.lesson_id} value={r.lesson_id}>
                    {formatTime(r.start_time)} · {r.group_name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </Loaded>
      </div>
      {lesson ? (
        <>
          <form className="scan-form" onSubmit={submit}>
            <label>
              {t("qr.code")}
              <input value={code} autoComplete="off" onChange={(e) => setCode(e.target.value)} />
            </label>
            <button type="submit" className="primary">
              {t("qr.mark")}
            </button>
            <button type="button" onClick={camera.toggle}>
              {camera.on ? t("qr.cameraOff") : t("qr.cameraOn")}
            </button>
          </form>
          {camera.failed ? <p className="note note-error" role="alert">{t("qr.cameraFailed")}</p> : null}
          {camera.on ? <video ref={camera.video} className="scanner" muted playsInline aria-label={t("qr.cameraView")} /> : null}
          <ul className="scan-log" aria-live="polite">
            {log.map((entry) => (
              <li key={entry.id}>
                {entry.scan ? (
                  <p className="done">
                    <strong>{entry.scan.student_name}</strong> · {label("scanResult", entry.scan.result)} · {label("mark", entry.scan.status)}
                  </p>
                ) : (
                  <ErrorNote error={entry.error!} />
                )}
              </li>
            ))}
          </ul>
          <RollCall key={`${lesson}-${turn}`} lessonId={lesson} />
        </>
      ) : (
        <p className="muted">{t("qr.pickLesson")}</p>
      )}
    </Page>
  );
}
