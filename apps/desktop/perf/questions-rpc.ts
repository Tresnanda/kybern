// Test transport only: substituted for the two question panels in this fixture.
export const sent: unknown[] = []
export const transport = { fail: false }
async function send(payload: unknown) {
  sent.push(payload)
  await new Promise((resolve) => setTimeout(resolve, 60))
  if (transport.fail) throw new Error("Unable to send. Try again.")
}
export const rpc = () => ({ call: (method: string, payload: unknown) => send({ method, payload }) })
export const respondApproval = (id: string, payload: unknown) => send({ id, payload })
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
