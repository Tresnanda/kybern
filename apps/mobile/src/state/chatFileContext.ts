import { createContext } from "react";
export const ChatFileContext = createContext<{ threadId: string; projectId?: string; basePath?: string; scope?: "thread" | "project" } | null>(null);
