import { api as browserApi } from "./localApi";
import { serverApi } from "./serverApi";

export const isDesktopRuntime = import.meta.env.VITE_RUNTIME_MODE === "desktop";
export const api = (isDesktopRuntime ? serverApi : browserApi) as typeof browserApi;
