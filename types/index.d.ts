export type Mode = 'light' | 'heavy'
export type Steering = 'interactive' | 'auto'

declare module 'claude-code' {
  interface PluginState {
    'ndev': { mode: Mode; steering: Steering }
  }
}
