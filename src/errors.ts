export class AgentboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentboxError";
  }
}

export function fail(message: string): never {
  throw new AgentboxError(message);
}
