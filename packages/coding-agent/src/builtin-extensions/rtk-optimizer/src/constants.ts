import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export const EXTENSION_NAME = "pi-rtk-optimizer";
export const CONFIG_DIR = join(getAgentDir(), "extensions", EXTENSION_NAME);
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
