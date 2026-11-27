/** Which way updates arrive: "poll" = getUpdates by a time trigger, otherwise the webhook. */
import { props } from "./telegram";

export const PROP_MODE = "TG_MODE";
export const pollingEnabled = (): boolean => props().getProperty(PROP_MODE) === "poll";
