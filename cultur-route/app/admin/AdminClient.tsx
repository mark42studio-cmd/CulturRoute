'use client'

import { useState, useTransition, useMemo } from 'react'
import {
  Search, MapPin, Utensils, Save, Link as LinkIcon, Image as ImageIcon,
  Eye, EyeOff, Edit2, X, Loader2, AlertCircle, CheckCircle, Trash2,
} from 'lucide-react'
import {
  togglePublished, geocodeAddress, updateEventFields, insertPlace, insertFood, deleteEvent,
} from './actions'

// ---- Types ----
export type AdminEvent = {
  id: string
  title: string
  start_time: string
  end_time: string | null
  venue_name: string | null
  latitude: number | null
  longitude: number | null
  is_published: boolean
  image_captured: string | null
}

type Tab = 'events' | 'places' | 'foods'
type SortMode = 'default' | 'name' | 'issues'

type EditState = {
  id: string
  title: string
  startTime: string
  endTime: string
  venueName: string
  address: string
  latitude: number | null
  longitude: number | null
  imageCaptured: string
  geocodedResult: { latitude: number; longitude: number; formatted: string } | null
}

type BatchProgress = { done: number; total: number }

// ---- Helpers ----
function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  try { return new Date(iso).toISOString().slice(0, 16) } catch { return '' }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('zh-TW', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return '—' }
}

/** 線上/Online 活動視為例外，不強制補座標 */
function isOnline(venueName: string | null): boolean {
  if (!venueName) return false
  return /線上|online/i.test(venueName)
}

/** 有場地名稱、非線上、且缺座標 → 可批次修復 */
function needsGeofix(e: AdminEvent): boolean {
  return !!e.venue_name && !isOnline(e.venue_name) && (!e.latitude || !e.longitude)
}

// ---- Main Component ----
export default function AdminClient({ initialEvents }: { initialEvents: AdminEvent[] }) {
  const [activeTab, setActiveTab] = useState<Tab>('events')
  const [events, setEvents] = useState(initialEvents)
  const [searchQuery, setSearchQuery] = useState('')
  const [editState, setEditState] = useState<EditState | null>(null)
  const [isPending, startTransition] = useTransition()
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null)

  // Batch state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isBatchRunning, setIsBatchRunning] = useState(false)
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null)

  // Sort state
  const [sortMode, setSortMode] = useState<SortMode>('default')

  // Filter state
  const [filterYear, setFilterYear] = useState<string>('all')
  const [filterMonth, setFilterMonth] = useState<string>('all')

  // Places/Foods state
  const [activeSubTab, setActiveSubTab] = useState<'places' | 'foods'>('places')
  const [mapSearchQuery, setMapSearchQuery] = useState('')
  const [isMapLoading, setIsMapLoading] = useState(false)
  const [mapResults, setMapResults] = useState<any[]>([])
  const [formData, setFormData] = useState({
    name: '', description: '', cuisine_type: '', price_range: '',
    latitude: '', longitude: '', vibe_tags: '', image_url: '', affiliate_url: '',
  })

  function showToast(type: 'ok' | 'err', msg: string) {
    setToast({ type, msg })
    setTimeout(() => setToast(null), 4000)
  }

  // ---- Available years (dynamic, descending) ----
  const availableYears = useMemo(() => {
    const years = new Set(events.map(e => new Date(e.start_time).getFullYear()))
    return Array.from(years).sort((a, b) => b - a)
  }, [events])

  // ---- Filtering + Sorting ----
  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    let base = q
      ? events.filter(e => e.title.toLowerCase().includes(q) || e.id.toLowerCase().includes(q))
      : [...events]

    if (filterYear !== 'all') {
      const y = parseInt(filterYear)
      base = base.filter(e => new Date(e.start_time).getFullYear() === y)
    }
    if (filterMonth !== 'all') {
      const m = parseInt(filterMonth)
      base = base.filter(e => new Date(e.start_time).getMonth() + 1 === m)
    }

    return base.sort((a, b) => {
      switch (sortMode) {
        case 'name':
          return a.title.localeCompare(b.title, 'zh-TW')
        case 'issues': {
          const weight = (e: AdminEvent) => needsGeofix(e) ? 0 : !e.is_published ? 1 : 2
          const diff = weight(a) - weight(b)
          return diff !== 0 ? diff : new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
        }
        default:
          return new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
      }
    })
  }, [events, searchQuery, sortMode, filterYear, filterMonth])

  const fixableInView = useMemo(() => filtered.filter(needsGeofix).length, [filtered])

  // ---- Events Tab Logic ----
  function handleToggle(event: AdminEvent) {
    startTransition(async () => {
      try {
        await togglePublished(event.id, event.is_published)
        setEvents(prev =>
          prev.map(e => e.id === event.id ? { ...e, is_published: !e.is_published } : e)
        )
        showToast('ok', `「${event.title}」已${event.is_published ? '下架' : '上架'}`)
      } catch (err: any) {
        showToast('err', err.message)
      }
    })
  }

  function openEdit(event: AdminEvent) {
    setEditState({
      id: event.id,
      title: event.title,
      startTime: toDatetimeLocal(event.start_time),
      endTime: toDatetimeLocal(event.end_time),
      venueName: event.venue_name ?? '',
      address: '',
      latitude: event.latitude,
      longitude: event.longitude,
      imageCaptured: event.image_captured ?? '',
      geocodedResult: null,
    })
  }

  function doGeocode(query: string) {
    startTransition(async () => {
      try {
        const result = await geocodeAddress(query)
        setEditState(s => s ? { ...s, geocodedResult: result, latitude: result.latitude, longitude: result.longitude } : s)
        showToast('ok', `已找到座標：${result.formatted}`)
      } catch (err: any) {
        showToast('err', err.message)
      }
    })
  }

  function handleGeocode() {
    if (!editState?.address.trim()) return
    doGeocode(editState.address)
  }

  function handleGeocodeFromVenue() {
    if (!editState?.venueName.trim()) return
    setEditState(s => s ? { ...s, address: s.venueName } : s)
    doGeocode(editState.venueName)
  }

  function handleSaveEdit() {
    if (!editState) return
    startTransition(async () => {
      try {
        await updateEventFields(editState.id, {
          start_time: editState.startTime ? new Date(editState.startTime).toISOString() : undefined,
          end_time: editState.endTime ? new Date(editState.endTime).toISOString() : null,
          venue_name: editState.venueName || undefined,
          latitude: editState.latitude ?? undefined,
          longitude: editState.longitude ?? undefined,
          image_captured: editState.imageCaptured || null,
        })
        setEvents(prev => prev.map(e =>
          e.id === editState.id
            ? {
                ...e,
                start_time: editState.startTime ? new Date(editState.startTime).toISOString() : e.start_time,
                end_time: editState.endTime ? new Date(editState.endTime).toISOString() : e.end_time,
                venue_name: editState.venueName || e.venue_name,
                latitude: editState.latitude,
                longitude: editState.longitude,
                image_captured: editState.imageCaptured || null,
              }
            : e
        ))
        showToast('ok', '已儲存活動變更')
        setEditState(null)
      } catch (err: any) {
        showToast('err', err.message)
      }
    })
  }

  // ---- Delete ----
  function handleDelete(event: AdminEvent) {
    if (!window.confirm(`確定要永久刪除「${event.title}」嗎？這無法復原。`)) return
    startTransition(async () => {
      try {
        await deleteEvent(event.id)
        setEvents(prev => prev.filter(e => e.id !== event.id))
        setSelectedIds(prev => { const n = new Set(prev); n.delete(event.id); return n })
        showToast('ok', `已永久刪除「${event.title}」`)
      } catch (err: any) {
        showToast('err', err.message)
      }
    })
  }

  // ---- Batch Selection ----
  function handleSelectAll() {
    const ids = filtered.filter(needsGeofix).map(e => e.id)
    setSelectedIds(new Set(ids))
  }

  function handleClearSelection() {
    setSelectedIds(new Set())
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // ---- Batch Geocoding ----
  async function handleBatchGeocode() {
    const targets = filtered.filter(e => selectedIds.has(e.id) && needsGeofix(e))
    if (targets.length === 0) return

    setIsBatchRunning(true)
    setBatchProgress({ done: 0, total: targets.length })

    let doneCount = 0
    const failed: string[] = []

    for (const event of targets) {
      try {
        const result = await geocodeAddress(event.venue_name!)
        await updateEventFields(event.id, {
          latitude: result.latitude,
          longitude: result.longitude,
        })
        setEvents(prev =>
          prev.map(e =>
            e.id === event.id
              ? { ...e, latitude: result.latitude, longitude: result.longitude }
              : e
          )
        )
        setSelectedIds(prev => {
          const next = new Set(prev)
          next.delete(event.id)
          return next
        })
      } catch {
        failed.push(event.title)
      }
      doneCount++
      setBatchProgress({ done: doneCount, total: targets.length })
    }

    setIsBatchRunning(false)
    setBatchProgress(null)

    if (failed.length === 0) {
      showToast('ok', `成功修復 ${targets.length} 筆活動座標`)
    } else {
      showToast(
        'err',
        `${targets.length - failed.length} 筆成功，${failed.length} 筆失敗：${failed.slice(0, 2).join('、')}${failed.length > 2 ? '…' : ''}`
      )
    }
  }

  // ---- Places/Foods Tab Logic ----
  async function handleMapSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!mapSearchQuery) return
    setIsMapLoading(true)
    setMapResults([])
    try {
      const res = await fetch('/api/places', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: mapSearchQuery }),
      })
      const data = await res.json()
      if (data.error) {
        alert(`Google API 錯誤：\n${data.error.message || JSON.stringify(data.error)}`)
        return
      }
      if (data.places?.length > 0) setMapResults(data.places)
      else alert('Google 地圖找不到結果。建議加上地區，例如：「台東 烏龍院」')
    } catch {
      alert('搜尋發生錯誤，請檢查網路狀態')
    } finally {
      setIsMapLoading(false)
    }
  }

  function handleSelectMapResult(place: any) {
    setFormData({
      ...formData,
      name: place.displayName?.text || '',
      description: place.editorialSummary?.text || '',
      latitude: place.location?.latitude?.toString() || '',
      longitude: place.location?.longitude?.toString() || '',
      vibe_tags: '',
      image_url: place.photoUrl || '',
      affiliate_url: '',
    })
  }

  async function handleSavePlace() {
    if (!formData.name || !formData.latitude || !formData.longitude) {
      alert('請至少填寫名稱與經緯度！')
      return
    }
    setIsMapLoading(true)
    try {
      const payload: Record<string, unknown> = {
        name: formData.name,
        latitude: parseFloat(formData.latitude),
        longitude: parseFloat(formData.longitude),
        vibe_tags: formData.vibe_tags.split(',').map(t => t.trim()).filter(Boolean),
        image_url: formData.image_url,
        affiliate_url: formData.affiliate_url,
      }
      if (activeSubTab === 'places') {
        payload.description = formData.description
        await insertPlace(payload)
      } else {
        payload.cuisine_type = formData.cuisine_type
        payload.price_range = formData.price_range
        await insertFood(payload)
      }
      alert(`成功加入${activeSubTab === 'places' ? '景點' : '美食'}：${formData.name}`)
      setFormData({ name: '', description: '', cuisine_type: '', price_range: '', latitude: '', longitude: '', vibe_tags: '', image_url: '', affiliate_url: '' })
      setMapResults([])
      setMapSearchQuery('')
    } catch (err: any) {
      alert('寫入失敗: ' + err.message)
    } finally {
      setIsMapLoading(false)
    }
  }

  // ---- Render ----
  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-800">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-5 py-3 rounded-xl shadow-lg text-sm font-bold ${toast.type === 'ok' ? 'bg-green-600 text-white' : 'bg-red-500 text-white'}`}>
          {toast.type === 'ok' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
          {toast.msg}
        </div>
      )}

      <div className="max-w-5xl mx-auto p-6 md:p-10 space-y-8">

        <header>
          <h1 className="text-3xl font-bold mb-1">CultureRoute 後台管理</h1>
          <p className="text-gray-400 text-sm">資料急診室 · 景點美食建檔</p>
        </header>

        {/* Main Tabs */}
        <div className="flex gap-3 border-b border-gray-200 pb-4 flex-wrap">
          {[
            { id: 'events', label: '🚑 活動急診室' },
            { id: 'places', label: '📍 景點管理' },
            { id: 'foods',  label: '🍜 美食管理' },
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id as Tab)}
              className={`px-5 py-2.5 rounded-xl font-bold text-sm transition-colors ${activeTab === id ? 'bg-slate-800 text-white shadow-md' : 'bg-white text-gray-500 hover:bg-gray-100 border border-gray-200'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* === Events Tab === */}
        {activeTab === 'events' && (
          <div className="space-y-4">

            {/* Search */}
            <div className="relative">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="以標題或 ID 搜尋..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-400 text-sm"
              />
            </div>

            {/* Year / Month Filter */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={filterYear}
                  onChange={e => setFilterYear(e.target.value)}
                  className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-bold text-gray-600 focus:outline-none focus:ring-2 focus:ring-slate-400"
                >
                  <option value="all">全部年份</option>
                  {availableYears.map(y => (
                    <option key={y} value={String(y)}>{y} 年</option>
                  ))}
                </select>
                <select
                  value={sortMode}
                  onChange={e => setSortMode(e.target.value as SortMode)}
                  className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-bold text-gray-600 focus:outline-none focus:ring-2 focus:ring-slate-400"
                >
                  <option value="default">🕐 預設（時間新→舊）</option>
                  <option value="name">🔤 名稱排序</option>
                  <option value="issues">⚠️ 問題置頂</option>
                </select>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {['all', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].map(m => (
                  <button
                    key={m}
                    onClick={() => setFilterMonth(m)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                      filterMonth === m
                        ? 'bg-violet-600 text-white shadow-sm'
                        : 'bg-white text-gray-500 border border-gray-200 hover:bg-violet-50 hover:text-violet-600 hover:border-violet-200'
                    }`}
                  >
                    {m === 'all' ? '全部' : `${m}月`}
                  </button>
                ))}
              </div>
            </div>

            {/* Batch Control Bar — 永遠顯示 */}
            <div className="flex items-center gap-2 flex-wrap bg-violet-50 border border-violet-200 rounded-xl px-4 py-3">
              <p className="text-xs font-bold text-violet-700 mr-1">
                {fixableInView > 0
                  ? <>{fixableInView} 筆可修復{selectedIds.size > 0 && <span className="text-violet-500"> · 已選 {selectedIds.size} 筆</span>}</>
                  : <span className="text-violet-400">目前無需修復的活動</span>
                }
              </p>
              <button
                onClick={handleSelectAll}
                disabled={isBatchRunning || fixableInView === 0}
                className="px-3 py-1.5 bg-violet-100 hover:bg-violet-200 text-violet-700 rounded-lg text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                全選可修復
              </button>
              <button
                onClick={handleClearSelection}
                disabled={selectedIds.size === 0 || isBatchRunning}
                className="px-3 py-1.5 bg-white hover:bg-gray-100 text-gray-500 rounded-lg text-xs font-bold border border-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                清除選取
              </button>
              <div className="flex-1" />
              {isBatchRunning ? (
                <div className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg text-xs font-bold">
                  <Loader2 size={13} className="animate-spin" />
                  處理中 {batchProgress?.done ?? 0} / {batchProgress?.total ?? 0} 筆...
                </div>
              ) : (
                <button
                  onClick={handleBatchGeocode}
                  disabled={selectedIds.size === 0}
                  className="flex items-center gap-1.5 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  🚀 批次修復所選座標
                </button>
              )}
            </div>

            <p className="text-xs text-gray-400 font-mono px-1">
              顯示 {filtered.length} / {events.length} 筆 · 橘色置頂 = 需補座標 · 紅色背景 = 已下架
            </p>

            {/* Event List */}
            <div className="space-y-2">
              {filtered.map(event => {
                const fixable = needsGeofix(event)
                const online = isOnline(event.venue_name)
                const isSelected = selectedIds.has(event.id)

                return (
                  <div
                    key={event.id}
                    className={`flex items-center gap-3 bg-white border rounded-xl px-4 py-3.5 transition-colors ${
                      !event.is_published
                        ? 'border-red-200 bg-red-50/40'
                        : fixable
                          ? 'border-amber-200 bg-amber-50/30'
                          : 'border-gray-100'
                    }`}
                  >
                    {/* Checkbox — 僅可修復項目可勾選 */}
                    <div className="shrink-0 w-5 flex justify-center">
                      {fixable ? (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(event.id)}
                          disabled={isBatchRunning}
                          className="w-4 h-4 accent-violet-600 cursor-pointer disabled:cursor-not-allowed"
                        />
                      ) : (
                        <span className="w-4 h-4" />
                      )}
                    </div>

                    {/* Thumbnail */}
                    <div className="shrink-0 w-10 h-10 rounded-lg overflow-hidden border border-gray-100 bg-gray-100 flex items-center justify-center">
                      {event.image_captured
                        ? <img src={event.image_captured} alt="" className="w-full h-full object-cover" />
                        : <span className="text-gray-300 text-xs">？</span>
                      }
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`shrink-0 w-2 h-2 rounded-full ${event.is_published ? 'bg-green-500' : 'bg-red-400'}`} />
                        <p className="font-bold text-gray-800 truncate text-sm">{event.title}</p>
                      </div>
                      <p className="text-xs text-gray-400 pl-4">
                        {formatDate(event.start_time)}
                        {' · '}
                        {event.venue_name
                          ? <span className={online ? 'text-sky-500' : undefined}>{event.venue_name}</span>
                          : <span className="text-amber-500">場地未設定</span>
                        }
                        {fixable && (
                          <span className="ml-2 text-amber-500 font-bold">⚠ 缺座標</span>
                        )}
                        {online && (
                          <span className="ml-2 text-sky-400 text-xs">（線上）</span>
                        )}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => openEdit(event)}
                        title="編輯"
                        className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
                      >
                        <Edit2 size={15} />
                      </button>
                      <button
                        onClick={() => handleToggle(event)}
                        disabled={isPending || isBatchRunning}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-40 ${
                          event.is_published
                            ? 'bg-green-100 text-green-700 hover:bg-red-100 hover:text-red-600'
                            : 'bg-red-100 text-red-600 hover:bg-green-100 hover:text-green-700'
                        }`}
                      >
                        {event.is_published
                          ? <><Eye size={12} /> 已上架</>
                          : <><EyeOff size={12} /> 已下架</>
                        }
                      </button>
                      <button
                        onClick={() => handleDelete(event)}
                        disabled={isPending || isBatchRunning}
                        title="永久刪除"
                        className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                )
              })}

              {filtered.length === 0 && (
                <div className="text-center py-16 text-gray-400 text-sm">找不到符合條件的活動</div>
              )}
            </div>
          </div>
        )}

        {/* === Places / Foods Tab === */}
        {(activeTab === 'places' || activeTab === 'foods') && (
          <div className="space-y-6">
            <div className="flex gap-3 border-b border-gray-100 pb-4">
              <button
                onClick={() => setActiveSubTab('places')}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm transition-colors ${activeSubTab === 'places' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-100 border border-gray-200'}`}
              >
                <MapPin size={15} /> 常駐景點
              </button>
              <button
                onClick={() => setActiveSubTab('foods')}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm transition-colors ${activeSubTab === 'foods' ? 'bg-orange-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-100 border border-gray-200'}`}
              >
                <Utensils size={15} /> 在地美食
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 h-fit">
                <h2 className="text-sm font-bold mb-4 flex items-center gap-2 text-gray-700">
                  <Search className="text-blue-500" size={16} /> 搜尋 Google Maps 資料
                </h2>
                <form onSubmit={handleMapSearch} className="flex gap-2 mb-5">
                  <input
                    type="text"
                    placeholder="輸入店名或地標..."
                    value={mapSearchQuery}
                    onChange={e => setMapSearchQuery(e.target.value)}
                    className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button type="submit" disabled={isMapLoading} className="bg-gray-800 text-white px-4 py-2 rounded-lg font-bold text-sm hover:bg-gray-700 disabled:opacity-50">
                    {isMapLoading ? '搜尋中...' : '搜尋'}
                  </button>
                </form>
                <div className="space-y-2">
                  {mapResults.map((place, idx) => (
                    <div
                      key={idx}
                      onClick={() => handleSelectMapResult(place)}
                      className="p-3 border border-gray-100 rounded-xl hover:border-blue-500 hover:bg-blue-50 cursor-pointer transition-colors"
                    >
                      <p className="font-bold text-gray-800 text-sm">{place.displayName?.text}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{place.formattedAddress}</p>
                    </div>
                  ))}
                  {mapResults.length === 0 && !isMapLoading && (
                    <div className="text-center text-gray-400 py-8 text-sm">請輸入關鍵字搜尋</div>
                  )}
                </div>
              </section>

              <section className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <h2 className="text-sm font-bold mb-5 text-gray-700">確認並編輯資料</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-1">名稱</label>
                    <input type="text" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-sm" />
                  </div>

                  {activeSubTab === 'places' ? (
                    <div>
                      <label className="block text-xs font-bold text-gray-500 mb-1">簡介</label>
                      <textarea value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} rows={3} className="w-full border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-sm" />
                    </div>
                  ) : (
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="block text-xs font-bold text-gray-500 mb-1">料理種類</label>
                        <input type="text" placeholder="原住民料理" value={formData.cuisine_type} onChange={e => setFormData({ ...formData, cuisine_type: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-sm" />
                      </div>
                      <div className="w-20">
                        <label className="block text-xs font-bold text-gray-500 mb-1">價位</label>
                        <select value={formData.price_range} onChange={e => setFormData({ ...formData, price_range: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-sm">
                          <option value="">-</option>
                          <option>$</option><option>$$</option><option>$$$</option>
                        </select>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="block text-xs font-bold text-gray-500 mb-1">緯度</label>
                      <input type="text" value={formData.latitude} readOnly className="w-full border border-gray-200 rounded-lg px-3 py-2 bg-gray-100 text-gray-500 text-sm" />
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs font-bold text-gray-500 mb-1">經度</label>
                      <input type="text" value={formData.longitude} readOnly className="w-full border border-gray-200 rounded-lg px-3 py-2 bg-gray-100 text-gray-500 text-sm" />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-1">客群標籤（逗號分隔）</label>
                    <input type="text" placeholder="文青, 親子" value={formData.vibe_tags} onChange={e => setFormData({ ...formData, vibe_tags: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-1 flex items-center gap-1">
                      <ImageIcon size={12} /> 圖片網址
                    </label>
                    {formData.image_url && (
                      <div className="mb-2 w-full h-28 rounded-lg overflow-hidden border border-gray-200">
                        <img src={formData.image_url} alt="預覽" className="w-full h-full object-cover" />
                      </div>
                    )}
                    <input type="text" placeholder="https://..." value={formData.image_url} onChange={e => setFormData({ ...formData, image_url: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-amber-600 mb-1 flex items-center gap-1">
                      <LinkIcon size={12} /> 分潤連結
                    </label>
                    <input type="text" placeholder="https://www.klook.com/..." value={formData.affiliate_url} onChange={e => setFormData({ ...formData, affiliate_url: e.target.value })} className="w-full border border-amber-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-amber-400 outline-none bg-amber-50/30" />
                  </div>

                  <button
                    onClick={handleSavePlace}
                    disabled={isMapLoading}
                    className="w-full mt-2 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white py-3 rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
                  >
                    <Save size={16} />
                    {isMapLoading ? '寫入中...' : `儲存至${activeSubTab === 'places' ? '景點' : '美食'}資料庫`}
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}
      </div>

      {/* === Edit Modal === */}
      {editState && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">

            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <div>
                <h2 className="font-bold text-gray-800">編輯活動</h2>
                <p className="text-xs text-gray-400 mt-0.5 max-w-xs truncate">{editState.title}</p>
              </div>
              <button onClick={() => setEditState(null)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-5">

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-1">開始時間</label>
                  <input
                    type="datetime-local"
                    value={editState.startTime}
                    onChange={e => setEditState(s => s ? { ...s, startTime: e.target.value } : s)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-slate-400 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 mb-1">結束時間</label>
                  <input
                    type="datetime-local"
                    value={editState.endTime}
                    onChange={e => setEditState(s => s ? { ...s, endTime: e.target.value } : s)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-slate-400 outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1">活動場地名稱</label>
                <input
                  type="text"
                  value={editState.venueName}
                  onChange={e => setEditState(s => s ? { ...s, venueName: e.target.value } : s)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-slate-400 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 mb-2 flex items-center gap-1">
                  <ImageIcon size={12} /> 活動圖片網址
                </label>
                <input
                  type="text"
                  placeholder="https://..."
                  value={editState.imageCaptured}
                  onChange={e => setEditState(s => s ? { ...s, imageCaptured: e.target.value } : s)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-slate-400 outline-none mb-2"
                />
                {editState.imageCaptured ? (
                  <img
                    src={editState.imageCaptured}
                    alt="預覽"
                    className="w-full max-h-40 object-cover rounded-lg border border-gray-200"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <div className="w-full h-20 rounded-lg border border-dashed border-gray-200 flex items-center justify-center text-xs text-gray-400">
                    無圖片預覽
                  </div>
                )}
              </div>

              <div className="border border-amber-200 bg-amber-50/40 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold text-amber-700 tracking-wider uppercase flex items-center gap-1.5">
                    <MapPin size={13} /> 地點修復（Geocoding）
                  </p>
                  <button
                    onClick={handleGeocodeFromVenue}
                    disabled={isPending || !editState.venueName.trim()}
                    title={editState.venueName ? `以「${editState.venueName}」查詢座標` : '請先填寫場地名稱'}
                    className="flex items-center gap-1 px-2.5 py-1 bg-violet-100 hover:bg-violet-200 text-violet-700 rounded-lg text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {isPending ? <Loader2 size={11} className="animate-spin" /> : '✨'}
                    用場地名稱查座標
                  </button>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="例：台東縣台東市中山路276號"
                    value={editState.address}
                    onChange={e => setEditState(s => s ? { ...s, address: e.target.value } : s)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleGeocode() } }}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-amber-400 outline-none bg-white"
                  />
                  <button
                    onClick={handleGeocode}
                    disabled={isPending || !editState.address.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-lg font-bold text-sm transition-colors disabled:opacity-50 shrink-0"
                  >
                    {isPending ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                    查詢座標
                  </button>
                </div>

                {editState.geocodedResult ? (
                  <div className="text-xs bg-white border border-green-200 rounded-lg px-3 py-2 text-green-700 font-mono leading-relaxed">
                    ✓ {editState.geocodedResult.formatted}<br />
                    lat {editState.geocodedResult.latitude.toFixed(6)}, lng {editState.geocodedResult.longitude.toFixed(6)}
                  </div>
                ) : (
                  editState.latitude != null && (
                    <p className="text-xs text-gray-400 font-mono">
                      目前座標：{editState.latitude.toFixed(6)}, {editState.longitude?.toFixed(6)}
                    </p>
                  )
                )}

                {editState.latitude == null && !editState.geocodedResult && (
                  <p className="text-xs text-amber-600 font-bold">⚠ 此活動尚無座標，請填寫地址並查詢</p>
                )}
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setEditState(null)}
                  className="flex-1 py-3 border border-gray-200 rounded-xl font-bold text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSaveEdit}
                  disabled={isPending}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
                >
                  {isPending ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  儲存變更
                </button>
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  )
}
