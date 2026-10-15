/**
 * planbar News – Beiträge der planbar-Infowand (GET /api/v1/news), als Liste
 * oder einzeln im Wechsel. Standardmässig nur Beiträge, die alle sehen
 * dürfen: Den Bildschirm kann lesen, wer davor steht. Mehrere Unternehmen:
 * die neusten Beiträge aller zusammen, jeder mit seinem Unternehmen.
 */
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { Lock, Megaphone, MessageSquare, TriangleAlert } from 'lucide-react';
import { normalizeSelection } from '../components/settings/multiselect';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { fetchNewsAll, type PlanbarFanOut, type PlanbarOrgNews } from '../planbar/orgs';
import type { PlanbarNewsPost, WithOrg } from '../planbar/types';
import type { WidgetProps } from '../types/widget';
import {
  PLANBAR_NEWS_DEFAULTS,
  PLANBAR_NEWS_MODES,
  PLANBAR_NEWS_SICHTBARKEIT,
  type PlanbarNewsSettings,
} from './manifests/planbar-news';
import { isNewPost, postBody } from './planbar/news';
import {
  PlanbarErrorMessage,
  PlanbarHead,
  PlanbarNoOrgsMessage,
  PlanbarOrgBadge,
  PlanbarOrgIssues,
  PlanbarSetupMessage,
  PlanbarStaleBanner,
} from './planbar/PlanbarParts';
import { safeColor } from './planbar/projects';
import { usePlanbarOrgs, usePlanbarPolling } from './planbar/usePlanbarPolling';
import { formatAgo, formatCount, parseTime } from './shared/format';
import { useNow } from './shared/hooks';
import { WidgetMessage } from './shared/WidgetParts';
import { readBoolean, readChoice, readNumber } from './shared/values';
import './styles/planbar-news.css';

const MAX_DOTS = 12;
const MAX_MENTIONS = 6;

function readSettings(raw: PlanbarNewsSettings): PlanbarNewsSettings {
  const defaults = PLANBAR_NEWS_DEFAULTS;
  return {
    unternehmen: normalizeSelection(raw.unternehmen),
    anzahl: readNumber(raw.anzahl, defaults.anzahl, 1, 20),
    mode: readChoice(raw.mode, PLANBAR_NEWS_MODES, defaults.mode),
    rotateSeconds: readNumber(raw.rotateSeconds, defaults.rotateSeconds, 5, 120),
    showTeaser: readBoolean(raw.showTeaser, defaults.showTeaser),
    showAuthor: readBoolean(raw.showAuthor, defaults.showAuthor),
    showComments: readBoolean(raw.showComments, defaults.showComments),
    sichtbarkeit: readChoice(raw.sichtbarkeit, PLANBAR_NEWS_SICHTBARKEIT, defaults.sichtbarkeit),
    refreshMinutes: readNumber(raw.refreshMinutes, defaults.refreshMinutes, 1, 60),
  };
}

type Post = WithOrg<PlanbarNewsPost>;

interface PostOptions {
  now: number;
  /** Several Unternehmen on screen: each post names its own. */
  showOrg: boolean;
  showTeaser: boolean;
  showAuthor: boolean;
  showComments: boolean;
}

function PostMeta({ post, options }: { post: Post; options: PostOptions }) {
  const created = parseTime(post.createdAt);
  const author = options.showAuthor ? post.author?.name.trim() : null;
  return (
    <div className="pn-meta">
      {options.showOrg && <PlanbarOrgBadge org={post.org} />}
      {author && <span className="pn-author">{author}</span>}
      {created !== null && <span className="pn-time">{formatAgo(created, options.now)}</span>}
      {options.showComments && post.commentCount > 0 && (
        <span className="pn-comments" title="Kommentare">
          <MessageSquare aria-hidden="true" />
          {formatCount(post.commentCount)}
        </span>
      )}
      {post.visibility !== 'member' && (
        <span className="pn-visibility" title="Sichtbarkeit in planbar">
          <Lock aria-hidden="true" />
          {post.visibilityLabel}
        </span>
      )}
    </div>
  );
}

function NewMark({ post, now }: { post: PlanbarNewsPost; now: number }) {
  return isNewPost(post, now) ? <span className="pn-new">Neu</span> : null;
}

const postKey = (post: Post): string => `${post.org.id}:${post.id}`;

function PostList({ posts, options }: { posts: readonly Post[]; options: PostOptions }) {
  return (
    <div className="pn-list">
      {posts.map((post) => (
        <article key={postKey(post)} className="pn-item">
          <h3 className="pn-title">
            <NewMark post={post} now={options.now} />
            {post.title}
          </h3>
          {options.showTeaser && post.teaser && <p className="pn-teaser">{post.teaser}</p>}
          <PostMeta post={post} options={options} />
        </article>
      ))}
    </div>
  );
}

function Mentions({ post }: { post: PlanbarNewsPost }) {
  const { users, teams, projects } = post.mentions;
  const chips = [
    ...teams.map((team) => ({ key: `t:${team.id}`, label: team.name, color: safeColor(team.color) })),
    ...users.map((user) => ({ key: `u:${user.id}`, label: `@${user.name}`, color: null })),
    ...projects.map((project, i) => ({ key: `p:${project.customerProjectId}:${i}`, label: project.name, color: null })),
  ];
  if (chips.length === 0) return null;
  return (
    <div className="pn-mentions">
      {chips.slice(0, MAX_MENTIONS).map((chip) => (
        <span
          key={chip.key}
          className={`pn-mention${chip.color ? ' pn-mention-team' : ''}`}
          style={chip.color ? ({ '--pn-team': chip.color } as CSSProperties) : undefined}
        >
          {chip.label}
        </span>
      ))}
      {chips.length > MAX_MENTIONS && <span className="pn-mention-more">+{formatCount(chips.length - MAX_MENTIONS)}</span>}
    </div>
  );
}

function PostRotation({ posts, options, rotateMs }: { posts: readonly Post[]; options: PostOptions; rotateMs: number }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (posts.length < 2) return;
    const timer = setInterval(() => setTick((value) => value + 1), rotateMs);
    return () => clearInterval(timer);
  }, [posts.length, rotateMs]);

  const index = tick % posts.length;
  const post = posts[index];
  const body = options.showTeaser ? postBody(post) : '';
  const comment = options.showComments ? post.lastComment : null;
  const commentAt = comment ? parseTime(comment.createdAt) : null;

  return (
    <div className="pn-rotation">
      {/* Keyed by post: every change mounts anew and fades in. */}
      <article key={postKey(post)} className="pn-hero">
        <PostMeta post={post} options={options} />
        <h3 className="pn-hero-title">
          <NewMark post={post} now={options.now} />
          {post.title}
        </h3>
        {body && <p className="pn-hero-text">{body}</p>}
        <Mentions post={post} />
        {comment && (
          <div className="pn-last-comment">
            <MessageSquare aria-hidden="true" />
            <span className="pn-last-comment-text">
              {comment.author?.name && <strong>{comment.author.name}: </strong>}
              {comment.teaser}
            </span>
            {commentAt !== null && <span className="pn-time">{formatAgo(commentAt, options.now)}</span>}
          </div>
        )}
      </article>
      {posts.length > 1 &&
        (posts.length <= MAX_DOTS ? (
          <div className="pn-dots" aria-hidden="true">
            {posts.map((entry, i) => (
              <span key={postKey(entry)} className={`pn-dot${i === index ? ' pn-dot-active' : ''}`} />
            ))}
          </div>
        ) : (
          <div className="pn-counter">
            {index + 1} / {posts.length}
          </div>
        ))}
    </div>
  );
}

export function PlanbarNewsWidget({ instanceId }: WidgetProps) {
  const [raw] = useWidgetSettings(instanceId, PLANBAR_NEWS_DEFAULTS);
  const settings = useMemo(() => readSettings(raw), [raw]);
  const now = useNow(60_000);

  const orgs = usePlanbarOrgs(settings.unternehmen);

  const poll = usePlanbarPolling<PlanbarFanOut<PlanbarOrgNews>>(
    (signal) => fetchNewsAll(orgs, { limit: settings.anzahl, sichtbarkeit: settings.sichtbarkeit }, { signal }),
    settings.refreshMinutes * 60_000,
    [orgs, settings.anzahl, settings.sichtbarkeit],
    orgs.length > 0,
  );

  if (poll.setup !== 'ready') return <PlanbarSetupMessage setup={poll.setup} />;
  if (orgs.length === 0) return <PlanbarNoOrgsMessage />;
  if (poll.data === null) {
    if (poll.failure) return <PlanbarErrorMessage failure={poll.failure} right="News – Lesen" />;
    if (poll.error !== null) return <WidgetMessage icon={TriangleAlert} tone="error" title="planbar-Fehler" detail={poll.error} />;
    return <WidgetMessage busy title="News werden geladen …" />;
  }

  const posts = poll.data.data.data;
  const stale = poll.failure !== null;
  const fresh = posts.filter((post) => isNewPost(post, now)).length;
  const options: PostOptions = {
    now,
    showOrg: poll.data.orgs.length > 1,
    showTeaser: settings.showTeaser,
    showAuthor: settings.showAuthor,
    showComments: settings.showComments,
  };

  return (
    <div className="pn">
      <PlanbarHead icon={Megaphone} lastUpdated={poll.lastUpdated} stale={stale}>
        Infowand
        {fresh > 0 && ` · ${formatCount(fresh)} neu`}
      </PlanbarHead>
      {poll.failure && <PlanbarStaleBanner failure={poll.failure} lastUpdated={poll.lastUpdated} />}
      {!poll.failure && <PlanbarOrgIssues failures={poll.data.failures} />}
      <div className={`pn-body${stale ? ' pn-body-stale' : ''}`}>
        {posts.length === 0 ? (
          <WidgetMessage
            icon={Megaphone}
            title="Keine Beiträge"
            detail={
              settings.sichtbarkeit === 'member'
                ? 'Auf der planbar-Infowand gibt es keine Beiträge für alle.'
                : 'Auf der planbar-Infowand gibt es noch keine Beiträge.'
            }
          />
        ) : settings.mode === 'rotation' ? (
          <PostRotation posts={posts} options={options} rotateMs={settings.rotateSeconds * 1000} />
        ) : (
          <PostList posts={posts} options={options} />
        )}
      </div>
    </div>
  );
}
