'use client';

import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { X } from 'lucide-react';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type FormState = {
  contact_email: string;
  event_name: string;
  description: string;
};

const INITIAL_FORM: FormState = {
  contact_email: '',
  event_name: '',
  description: '',
};

export default function ReportIssueModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [errors, setErrors] = useState<Partial<FormState & { _global: string }>>({});

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const { name, value } = e.target;
    setForm(prev => ({ ...prev, [name]: value }));
    setErrors(prev => ({ ...prev, [name]: '' }));
  }

  function validate(): Partial<FormState & { _global: string }> {
    const e: Partial<FormState & { _global: string }> = {};
    if (!form.description.trim()) e.description = '請描述問題內容';
    return e;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }

    setLoading(true);
    const { error } = await supabase.from('issue_reports').insert([{
      contact_email: form.contact_email.trim() || null,
      event_name:    form.event_name.trim()    || null,
      description:   form.description.trim(),
    }]);
    setLoading(false);

    if (error) {
      setErrors({ _global: `送出失敗：${error.message}` });
    } else {
      setSubmitted(true);
      setTimeout(() => {
        setIsOpen(false);
        setSubmitted(false);
        setForm(INITIAL_FORM);
      }, 2000);
    }
  }

  function handleClose() {
    if (loading) return;
    setIsOpen(false);
    setSubmitted(false);
    setForm(INITIAL_FORM);
    setErrors({});
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="text-center px-6 py-2.5 rounded-full border border-stone-300 text-stone-500 hover:bg-stone-100 text-sm tracking-wide transition-all duration-300"
      >
        🔧 活動有問題 我要報修
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/50 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">

            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <div>
                <h2 className="font-bold text-gray-800 text-lg">活動報修</h2>
                <p className="text-xs text-gray-400 mt-0.5">告訴我們哪裡有問題，我們會盡快修正</p>
              </div>
              <button
                onClick={handleClose}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Success State */}
            {submitted ? (
              <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
                <div className="text-5xl mb-4">✅</div>
                <p className="font-bold text-gray-800 text-lg">感謝您的回報！</p>
                <p className="text-sm text-gray-500 mt-1">我們收到了，會盡快處理</p>
              </div>
            ) : (

              /* Form */
              <form onSubmit={handleSubmit} className="p-6 space-y-5">
                {errors._global && (
                  <div className="bg-red-50 border border-red-200 text-red-600 rounded-lg px-4 py-3 text-sm">
                    {errors._global}
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="block text-sm font-semibold text-slate-700">
                    聯絡信箱
                    <span className="text-xs font-normal text-gray-400 ml-1">（選填，方便我們回覆您）</span>
                  </label>
                  <input
                    type="email"
                    name="contact_email"
                    value={form.contact_email}
                    onChange={handleChange}
                    placeholder="your@email.com"
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-slate-800 text-sm outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-sm font-semibold text-slate-700">
                    有問題的活動名稱
                    <span className="text-xs font-normal text-gray-400 ml-1">（選填）</span>
                  </label>
                  <input
                    type="text"
                    name="event_name"
                    value={form.event_name}
                    onChange={handleChange}
                    placeholder="例：2026 台東藝術節"
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-slate-800 text-sm outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-sm font-semibold text-slate-700">
                    問題描述
                    <span className="text-orange-500 ml-0.5">*</span>
                  </label>
                  <textarea
                    name="description"
                    value={form.description}
                    onChange={handleChange}
                    rows={4}
                    placeholder="例：活動時間標示錯誤、地點與實際不符、活動已取消但仍顯示…"
                    className={[
                      'w-full rounded-lg border px-4 py-2.5 text-slate-800 text-sm outline-none transition-colors focus:ring-2 focus:ring-orange-400 focus:border-transparent',
                      errors.description
                        ? 'border-red-400 bg-red-50'
                        : 'border-slate-200 bg-slate-50',
                    ].join(' ')}
                  />
                  {errors.description && (
                    <p className="text-xs text-red-500">{errors.description}</p>
                  )}
                </div>

                <div className="flex gap-3 pt-1">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="flex-1 py-2.5 border border-gray-200 rounded-xl font-semibold text-sm text-gray-500 hover:bg-gray-50 transition-colors"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 py-2.5 bg-amber-700 hover:bg-amber-800 disabled:bg-amber-300 text-white font-semibold rounded-xl text-sm transition-colors"
                  >
                    {loading ? '送出中…' : '送出報修'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
