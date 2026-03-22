export class ArchitectsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchitectsError';
  }
}
