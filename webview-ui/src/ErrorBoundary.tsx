import {Component, type ErrorInfo, type ReactNode} from 'react';

type Props = {children: ReactNode};
type State = {error: Error | null};

export class ErrorBoundary extends Component<Props, State> {
  state: State = {error: null};

  static getDerivedStateFromError(error: Error): State {
    return {error};
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[GravityEdit] Uncaught error in editor:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            fontFamily: 'monospace',
            color: '#f48771',
            whiteSpace: 'pre-wrap',
            overflowY: 'auto',
            height: '100%',
          }}
        >
          <strong>Gravity Markdown Editor - render error</strong>
          {'\n\n'}
          {String(this.state.error)}
          {'\n\n'}
          Open Help → Toggle Developer Tools in the Extension Development Host for the full stack.
        </div>
      );
    }
    return this.props.children;
  }
}
