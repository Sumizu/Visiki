import { ArrowRight, AudioLines, Clapperboard } from 'lucide-react';
import './workspace-welcome.css';

type WorkspaceWelcomeProps = {
  onChoose: (id: 'edit' | 'daw') => void;
};

export function WorkspaceWelcome({ onChoose }: WorkspaceWelcomeProps) {
  return (
    <main className="workspace-welcome" aria-labelledby="workspace-welcome-title">
      <div className="workspace-welcome-content">
        <h1 id="workspace-welcome-title">选择工作区</h1>
        <div className="workspace-welcome-options">
          <button type="button" className="workspace-welcome-card" aria-label="进入剪辑" onClick={() => onChoose('edit')}>
            <span className="workspace-welcome-icon" aria-hidden="true"><Clapperboard size={24} strokeWidth={1.6} /></span>
            <span className="workspace-welcome-card-copy">
              <strong>剪辑</strong>
              <span>编辑音乐视频、歌词与画面</span>
            </span>
            <ArrowRight className="workspace-welcome-arrow" size={17} aria-hidden="true" />
          </button>
          <button type="button" className="workspace-welcome-card" aria-label="进入 DAW" onClick={() => onChoose('daw')}>
            <span className="workspace-welcome-icon" aria-hidden="true"><AudioLines size={24} strokeWidth={1.6} /></span>
            <span className="workspace-welcome-card-copy">
              <strong>DAW</strong>
              <span>编辑音轨与混音</span>
            </span>
            <ArrowRight className="workspace-welcome-arrow" size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
    </main>
  );
}
