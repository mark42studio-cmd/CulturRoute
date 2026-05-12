'use client';

import { useState, useRef, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function isValidHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

interface Props {
  onSuccess: () => void;
  onCancel?: () => void;
  successButtonLabel?: string;
}

export default function SubmitEventFormContent({
  onSuccess,
  onCancel,
  successButtonLabel = '確認，返回首頁',
}: Props) {
  const mounted = useRef(true);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    title: '',
    event_time: '',
    location: '',
    description: '',
    image_url: '',
    ticket_url: '',
    comments: '',
  });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.title.trim()) e.title = '請填寫活動名稱';
    if (!form.event_time.trim()) e.event_time = '請填寫活動時間';
    if (!form.location.trim()) e.location = '請填寫活動地點';
    if (!form.description.trim()) e.description = '請填寫活動介紹';
    if (form.image_url.trim() && !isValidHttpsUrl(form.image_url.trim()))
      e.image_url = '圖片連結必須以 https:// 開頭';
    if (form.ticket_url.trim() && !isValidHttpsUrl(form.ticket_url.trim()))
      e.ticket_url = '購票連結必須以 https:// 開頭';
    return e;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setErrors(prev => ({ ...prev, [e.target.name]: '' }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }

    setLoading(true);

    let start_date: string | null = null;
    let end_date: string | null = null;
    try {
      const res = await fetch('/api/parse-date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawDate: form.event_time.trim() }),
      });
      const parsed = await res.json();
      start_date = parsed.start_date ?? null;
      end_date = parsed.end_date ?? null;
    } catch {
      // silent fail, raw_date still written
    }

    const { error } = await supabase.from('submissions').insert([{
      title: form.title.trim(),
      raw_date: form.event_time.trim(),
      start_date,
      end_date,
      location: form.location.trim(),
      description: form.description.trim(),
      image_url: form.image_url.trim() || null,
      ticket_url: form.ticket_url.trim() || null,
      comments: form.comments.trim() || null,
    }]);

    if (!mounted.current) return;
    setLoading(false);

    if (error) {
      setErrors({ _global: `提交失敗：${error.message}` });
    } else {
      setSubmitted(true);
    }
  };

  if (submitted) {
    return (
      <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
        <div className="text-5xl mb-4">🎉</div>
        <h2 className="text-xl font-bold text-slate-800 mb-3">投稿成功！</h2>
        <p className="text-slate-600 text-sm leading-relaxed mb-6">
          投稿成功後，如隔天沒有上架，<br />
          請再寫信聯繫平台方<br />
          <a
            href="mailto:mark42studio@gmail.com"
            className="text-orange-500 font-semibold break-all"
          >
            mark42studio@gmail.com
          </a>
        </p>
        <button
          onClick={onSuccess}
          className="w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-2.5 rounded-xl transition-colors"
        >
          {successButtonLabel}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {errors._global && (
        <div className="bg-red-50 border border-red-200 text-red-600 rounded-lg px-4 py-3 text-sm">
          {errors._global}
        </div>
      )}

      <Field label="活動名稱" required error={errors.title}>
        <input
          name="title"
          value={form.title}
          onChange={handleChange}
          placeholder="例：2026 臺東藝穗節"
          className={inputClass(errors.title)}
        />
      </Field>

      <Field label="活動時間" required error={errors.event_time} hint="格式不限，例：下週六下午、2026/06/01 14:00–17:00">
        <input
          name="event_time"
          value={form.event_time}
          onChange={handleChange}
          placeholder="例：2026/06/01 14:00 – 17:00"
          className={inputClass(errors.event_time)}
        />
      </Field>

      <Field label="活動地點" required error={errors.location}>
        <input
          name="location"
          value={form.location}
          onChange={handleChange}
          placeholder="例：台東縣台東市中正路 1 號"
          className={inputClass(errors.location)}
        />
      </Field>

      <Field label="活動介紹" required error={errors.description}>
        <textarea
          name="description"
          value={form.description}
          onChange={handleChange}
          rows={5}
          placeholder="請簡單描述活動內容、特色與對象…"
          className={inputClass(errors.description)}
        />
      </Field>

      <Field label="圖片連結" error={errors.image_url} hint="選填，需為 https:// 開頭的公開網址，請事先壓縮圖片">
        <input
          name="image_url"
          value={form.image_url}
          onChange={handleChange}
          placeholder="https://example.com/poster.jpg"
          className={inputClass(errors.image_url)}
        />
      </Field>

      <Field label="購票連結 (Ticket URL)" error={errors.ticket_url} hint="選填，需為 https:// 開頭，若無售票頁面可略過">
        <input
          name="ticket_url"
          value={form.ticket_url}
          onChange={handleChange}
          placeholder="https://kktix.com/events/..."
          className={inputClass(errors.ticket_url)}
        />
      </Field>

      <Field label="其他建議" hint="選填，有任何補充或備註都歡迎告訴我們">
        <textarea
          name="comments"
          value={form.comments}
          onChange={handleChange}
          rows={3}
          placeholder="例：有售票連結、合作洽詢方式…"
          className={inputClass()}
        />
      </Field>

      <div className={onCancel ? 'flex gap-3' : ''}>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-3 border border-gray-200 rounded-xl font-semibold text-sm text-gray-500 hover:bg-gray-50 transition-colors"
          >
            取消
          </button>
        )}
        <button
          type="submit"
          disabled={loading}
          className={`${onCancel ? 'flex-1' : 'w-full'} bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white font-semibold py-3 rounded-xl transition-colors text-base`}
        >
          {loading ? '提交中…' : '送出投稿'}
        </button>
      </div>
    </form>
  );
}

function inputClass(error?: string) {
  return [
    'w-full rounded-lg border px-4 py-2.5 text-slate-800 text-sm outline-none transition-colors',
    'focus:ring-2 focus:ring-orange-400 focus:border-transparent',
    error ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-slate-50',
  ].join(' ');
}

function Field({
  label, required, hint, error, children,
}: {
  label: string; required?: boolean; hint?: string; error?: string; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-semibold text-slate-700">
        {label}
        {required && <span className="text-orange-500 ml-0.5">*</span>}
      </label>
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
      {children}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
