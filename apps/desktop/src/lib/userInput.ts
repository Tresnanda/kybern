import type { ApprovalRequest } from "@/protocol"

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const string = (value: unknown): string => typeof value === "string" ? value : ""
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []

export function isUserInput(approval: ApprovalRequest): boolean {
  return ["AskUserQuestion", "request_user_input", "opencode_question", "mcp_elicitation", "ui_select", "ui_confirm", "ui_input", "ui_editor"].includes(approval.tool_name)
}

export function questionsFor(approval: ApprovalRequest) {
  return array(record(approval.input).questions).map((item, index) => {
    const question = record(item)
    return {
      id: string(question.id) || String(index),
      title: string(question.question),
      header: string(question.header),
      multiple: question.multiSelect === true || question.multiple === true,
      custom: question.custom !== false,
      secret: question.isSecret === true,
      options: array(question.options).map((item) => typeof item === "string" ? { label: item, description: "" } : { label: string(record(item).label), description: string(record(item).description) }),
    }
  })
}

export function questionResponse(approval: ApprovalRequest, answers: string[][]): unknown {
  const questions = questionsFor(approval)
  if (answers.length !== questions.length || answers.some((answer) => !answer.length || answer.some((s) => !s.trim()))) throw new Error("Answer each question before continuing.")
  if (approval.tool_name === "opencode_question") return { answers }
  if (approval.tool_name === "AskUserQuestion") return { answers: Object.fromEntries(questions.map((q, i) => [q.title, answers[i]!.join(", ")])) }
  return { answers: Object.fromEntries(questions.map((q, i) => [q.id, { answers: answers[i] }])) }
}
