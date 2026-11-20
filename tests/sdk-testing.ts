import { test as register } from 'claude-code/testing'
import { withSdkExecutionBudget } from './sdk-execution.mjs'

export * from 'claude-code/testing'
export const test: typeof register = withSdkExecutionBudget(register)
