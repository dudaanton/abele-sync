export class NodeReplicaConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}
