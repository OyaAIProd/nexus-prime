export class SynapseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynapseError';
  }
}

export class SynapseApprovalPendingError extends SynapseError {
  constructor(message: string) {
    super(message);
    this.name = 'SynapseApprovalPendingError';
  }
}

export class SynapseBudgetExceededError extends SynapseError {
  constructor(message: string) {
    super(message);
    this.name = 'SynapseBudgetExceededError';
  }
}
