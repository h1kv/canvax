interface HostedNotificationProps {
  url: string;
  workspacePath: string;
  onDismiss: () => void;
}

export function HostedNotification({ url, workspacePath, onDismiss }: HostedNotificationProps) {
  return (
    <div className="hosted-notif" role="status" aria-live="polite">
      <div className="hosted-notif-header">
        <span className="hosted-notif-title">Site hosted</span>
        <span className="hosted-notif-path">{workspacePath}</span>
        <button
          type="button"
          className="hosted-notif-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss notification"
        >
          ×
        </button>
      </div>
      <div className="hosted-notif-preview">
        <iframe
          src={url}
          title="Site preview"
          sandbox="allow-scripts allow-same-origin"
          loading="lazy"
        />
      </div>
      <div className="hosted-notif-actions">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="hosted-notif-open"
        >
          Open ↗
        </a>
      </div>
    </div>
  );
}
