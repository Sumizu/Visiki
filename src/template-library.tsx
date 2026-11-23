import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Sparkles } from 'lucide-react';
import { isVideoBackground } from './background-video';
import { getLoadedFontRevision, loadProjectFonts } from './fonts';
import { renderScene } from './scene';
import { applyProjectTemplate, PROJECT_TEMPLATES } from './templates';
import type { TemplateApplyOptions } from './templates';
import type { DemoProject, SceneResources } from './types';
import './template-library.css';

export interface TemplateLibraryProps {
  project: DemoProject;
  getResources: () => SceneResources;
  onApply: (id: string, options: TemplateApplyOptions) => void;
}

/** Fit the complete canvas inside the thumbnail, including portrait projects. */
function previewSize(project: DemoProject): { width: number; height: number } {
  const ratio = Math.max(1, project.width) / Math.max(1, project.height);
  const width = Math.min(360, 203 * ratio);
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(width / ratio)) };
}

function previewTime(project: DemoProject): number {
  return Math.min(Math.max(0, project.duration * .35), 12);
}

export function TemplateLibrary({ project, getResources, onApply }: TemplateLibraryProps) {
  const [keepCustomLayers, setKeepCustomLayers] = useState(true);
  const [resourceRevision, setResourceRevision] = useState(0);
  const [fontWarning, setFontWarning] = useState(false);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const resourceGetter = useRef(getResources);
  resourceGetter.current = getResources;
  const projectRef = useRef(project);
  projectRef.current = project;
  const canvases = useRef(new Map<string, HTMLCanvasElement>());

  const previews = useMemo(() => PROJECT_TEMPLATES.map(template => {
    try {
      return { template, project: applyProjectTemplate(project, template.id, { keepCustomLayers }), error: '' };
    } catch (error) {
      // A preview must not take down the editor when retaining custom tracks
      // exceeds the project limit. The checkbox remains available to recover.
      const tooManyTracks = error instanceof Error && /100.*轨道|轨道.*100/.test(error.message);
      return { template, project: null, error: tooManyTracks ? '轨道过多，请取消保留选项' : '预览暂不可用' };
    }
  }), [project, keepCustomLayers]);

  useEffect(() => {
    // Resources arrive asynchronously through refs. Playback also replaces the
    // video-frame map frequently; that must not animate all six thumbnails.
    const signature = (): unknown[] => {
      const resources = resourceGetter.current();
      const videoReadiness = projectRef.current.layers
        .filter(layer => layer.type === 'video' || isVideoBackground(layer))
        .map(layer => `${layer.id}:${resources.videos?.has(layer.id) ? '1' : '0'}`)
        .join('|');
      return [resources.cover, resources.images, resources.analysis, getLoadedFontRevision(), videoReadiness];
    };
    let previous = signature();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const current = signature();
      if (current.every((value, index) => value === previous[index])) return;
      previous = current;
      setResourceRevision(revision => revision + 1);
    }, 750);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFontWarning(false);
    void Promise.allSettled(previews.flatMap(({ project: preview }) => {
      if (!preview) return [];
      const time = previewTime(preview);
      return [loadProjectFonts(preview, { start: time, end: time + 1 / preview.fps })];
    })).then(results => {
      if (cancelled) return;
      setFontWarning(results.some(result => result.status === 'rejected'));
      setResourceRevision(revision => revision + 1);
    });
    return () => { cancelled = true; };
  }, [previews]);

  useEffect(() => {
    let cancelled = false;
    let handle = 0;
    let index = 0;
    const resources = resourceGetter.current();
    // Snapshot the existing resources without changing the main preview's maps
    // or fetching media. Each card uses the same project and scene renderer as
    // applying the template; only its output resolution is reduced.
    const snapshot: SceneResources = {
      cover: resources.cover,
      analysis: resources.analysis,
      images: resources.images,
      videos: resources.videos,
    };
    setPreviewErrors([]);
    const paintNext = () => {
      if (cancelled || index >= previews.length) return;
      const { template, project: preview } = previews[index++];
      const canvas = canvases.current.get(template.id);
      if (canvas && preview) {
        const size = previewSize(preview);
        if (canvas.width !== size.width) canvas.width = size.width;
        if (canvas.height !== size.height) canvas.height = size.height;
        try {
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('Canvas unavailable');
          context.setTransform(canvas.width / preview.width, 0, 0, canvas.height / preview.height, 0, 0);
          const previewResources: SceneResources = {
            ...snapshot,
            videos: snapshot.videos ? new Map(snapshot.videos) : undefined,
          };
          // Template backgrounds receive new layer IDs. Reuse an existing
          // source frame under that ID without decoding or mutating the editor.
          for (const layer of preview.layers) {
            if (!isVideoBackground(layer)) continue;
            const source = project.layers.find(original => isVideoBackground(original)
              && original.params.videoId === layer.params.videoId && snapshot.videos?.has(original.id));
            const frame = source ? snapshot.videos?.get(source.id) : undefined;
            if (frame) previewResources.videos?.set(layer.id, frame);
          }
          renderScene(context, preview, previewTime(preview), previewResources);
        } catch {
          if (!cancelled) setPreviewErrors(errors => [...errors, template.id]);
        }
      }
      if (index < previews.length) handle = window.requestAnimationFrame(paintNext);
    };
    handle = window.requestAnimationFrame(paintNext);
    return () => { cancelled = true; window.cancelAnimationFrame(handle); };
  }, [previews, resourceRevision]);

  return <div className="library-content template-library" data-testid="templates-library">
    <div className="template-library-heading">
      <div><Sparkles size={15} aria-hidden="true" /><h2>模板</h2></div>
      <span>{PROJECT_TEMPLATES.length} 款</span>
    </div>
    <label className="template-preserve-option">
      <input type="checkbox" checked={keepCustomLayers} onChange={event => setKeepCustomLayers(event.target.checked)} />
      <span>保留现有视频和文本轨道</span>
    </label>
    <div className="template-card-list">
      {previews.map(({ template, error }, index) => <article
        className="template-card"
        key={template.id}
        data-testid={`template-card-${template.id}`}
        style={{ '--template-accent': template.accent } as CSSProperties}
      >
        <div className="template-preview-frame">
          <canvas
            ref={canvas => { if (canvas) canvases.current.set(template.id, canvas); else canvases.current.delete(template.id); }}
            className="template-preview-canvas"
            role="img"
            aria-label={`${template.name}静态预览`}
            data-testid={`template-preview-${template.id}`}
          />
          <span className="template-preview-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          {(error || previewErrors.includes(template.id)) && <span className="template-preview-error">{error || '预览暂不可用'}</span>}
        </div>
        <div className="template-card-actions">
          <button
            type="button"
            className="template-apply-button"
            disabled={Boolean(error)}
            aria-label={`应用${template.name}`}
            data-testid={`template-apply-${template.id}`}
            onClick={() => onApply(template.id, { keepCustomLayers })}
          >应用</button>
        </div>
      </article>)}
    </div>
    {fontWarning && <p className="template-font-warning" role="status">部分字体暂未加载，预览使用系统字体。</p>}
  </div>;
}
