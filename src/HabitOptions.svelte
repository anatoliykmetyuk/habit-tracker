<script lang="ts">
	import { onMount, onDestroy } from 'svelte'
	import { TFile, parseYaml, Notice } from 'obsidian'
	import { isValidCSSColor } from './utils'

	export let app
	export let path: string
	export let pluginName: string

	let file: TFile | null = null
	let frontmatter: Record<string, any> = {}
	let error = ''
	let loading = true
	let saving = 0 // count of in-flight saves, for the header indicator

	// Debounce timers per field, so rapid typing only triggers one write
	const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {}

	const NUMERIC_DAILY = 'numeric-daily-objective'
	const NUMERIC_WEEKLY = 'numeric-weekly-objective'

	async function load() {
		loading = true
		error = ''
		try {
			let abs = app.vault.getAbstractFileByPath(path)
			if (!abs && !path.endsWith('.md')) {
				abs = app.vault.getAbstractFileByPath(path + '.md')
			}
			if (!abs) {
				error = `File not found: "${path}"`
				file = null
				return
			}
			if (!(abs instanceof TFile)) {
				error = `Path is not a file: "${path}"`
				file = null
				return
			}
			file = abs
			const content = await app.vault.read(file)
			const match = content.match(/^---\n([\s\S]*?)\n---/)
			frontmatter = match ? { ...(parseYaml(match[1]) || {}) } : {}
		} catch (e: any) {
			error = e?.message ?? String(e)
			file = null
		} finally {
			loading = false
		}
	}

	// Write a single field. Empty string / null / undefined removes the key.
	// The `entries` key is never touched here; it's owned by the tracker.
	async function saveField(field: string, value: any) {
		if (!file) return
		saving += 1
		try {
			await app.fileManager.processFrontMatter(file, (fm) => {
				if (value === '' || value === null || value === undefined) {
					delete fm[field]
				} else {
					fm[field] = value
				}
			})
			// Optimistic local update so the input doesn't flicker
			if (value === '' || value === null || value === undefined) {
				delete frontmatter[field]
			} else {
				frontmatter[field] = value
			}
			frontmatter = frontmatter
		} catch (e: any) {
			new Notice(`${pluginName}: failed to save "${field}" — ${e?.message ?? e}`)
		} finally {
			saving -= 1
		}
	}

	function debouncedSave(field: string, value: any, delay = 500) {
		if (saveTimers[field]) clearTimeout(saveTimers[field])
		saveTimers[field] = setTimeout(() => {
			delete saveTimers[field]
			void saveField(field, value)
		}, delay)
	}

	// Flushing pending writes on unmount prevents losing the last keystrokes
	// if the user navigates away mid-debounce.
	async function flushPending() {
		const fields = Object.keys(saveTimers)
		for (const field of fields) {
			clearTimeout(saveTimers[field])
			delete saveTimers[field]
		}
		if (file) await app.fileManager.processFrontMatter(file, () => {})
	}

	// --- Handlers ---

	function onTitleInput(e: Event) {
		debouncedSave('title', (e.target as HTMLInputElement).value)
	}

	function onColorInput(e: Event) {
		debouncedSave('color', (e.target as HTMLInputElement).value)
	}

	function onColorPickerInput(e: Event) {
		// Picker always emits #rrggbb; debounce to keep it in sync with typing.
		debouncedSave('color', (e.target as HTMLInputElement).value)
	}

	async function onNumericToggle(e: Event) {
		const next = (e.target as HTMLInputElement).checked
		if (!file) return
		saving += 1
		try {
			// Only flip the `numeric` flag. Never rewrite `entries` — its shape
			// is a consequence of how the habit has been used, not of the
			// current mode. The view in Habit.svelte reads dates from both
			// array and object shapes.
			await app.fileManager.processFrontMatter(file, (fm) => {
				fm.numeric = next
			})
			frontmatter.numeric = next
			frontmatter = frontmatter
		} catch (e: any) {
			new Notice(`${pluginName}: failed to save — ${e?.message ?? e}`)
		} finally {
			saving -= 1
		}
	}

	function onMetricInput(e: Event) {
		debouncedSave('numeric-metric', (e.target as HTMLInputElement).value)
	}

	function onNumberChange(field: string, e: Event) {
		const raw = (e.target as HTMLInputElement).value
		if (raw === '') {
			void saveField(field, null)
		} else {
			const n = Number(raw)
			if (Number.isFinite(n)) void saveField(field, n)
		}
	}

	function onMaxGapInput(e: Event) {
		const raw = (e.target as HTMLInputElement).value
		const n = raw === '' ? 0 : Number(raw)
		if (Number.isFinite(n)) debouncedSave('maxGap', n)
	}

	// --- Derived ---

	$: isNumeric = frontmatter.numeric === true
	$: colorValid = !frontmatter.color || isValidCSSColor(frontmatter.color)

	// <input type="color"> only accepts #rrggbb. Resolve any valid CSS color
	// to hex via a temporary element so the picker reflects the current value;
	// fall back to #000000 for missing or invalid colors.
	function colorToHex(color: string | undefined): string {
		if (!color) return '#000000'
		const probe = document.createElement('div')
		probe.style.color = color
		document.body.appendChild(probe)
		const computed = getComputedStyle(probe).color
		probe.remove()
		const m = computed.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
		if (!m) return '#000000'
		const hex = (n: string) =>
			Math.max(0, Math.min(255, parseInt(n, 10)))
				.toString(16)
				.padStart(2, '0')
		return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
	}

	onMount(load)
	onDestroy(() => {
		void flushPending()
	})
</script>

{#if error}
	<div class="ht21-options ht21-options--error">
		<strong>🛑 {pluginName}</strong>: {error}
	</div>
{:else if loading}
	<div class="ht21-options ht21-options--loading">Loading <code>{path}</code>…</div>
{:else if file}
	<div class="ht21-options">
		<div class="ht21-options-header">
			<span class="ht21-options-header__icon">⚙️</span>
			<span class="ht21-options-header__title">{file.basename}</span>
			<span class="ht21-options-header__path">{file.path}</span>
			{#if saving > 0}
				<span class="ht21-options-header__saving">Saving…</span>
			{/if}
		</div>

		<div class="ht21-options-section">
			<h5 class="ht21-options-section__heading">General</h5>

			<div class="ht21-options-row">
				<div class="ht21-options-row__info">
					<div class="ht21-options-row__name">Title</div>
					<div class="ht21-options-row__desc">Display name. Falls back to the filename if empty.</div>
				</div>
				<div class="ht21-options-row__control">
					<input
						type="text"
						class="ht21-input"
						value={frontmatter.title ?? ''}
						on:input={onTitleInput}
						placeholder={file.basename}
					/>
				</div>
			</div>

			<div class="ht21-options-row">
				<div class="ht21-options-row__info">
					<div class="ht21-options-row__name">Color</div>
					<div class="ht21-options-row__desc">CSS color (hex, RGB, or name). Invalid values are ignored by the tracker.</div>
				</div>
				<div class="ht21-options-row__control ht21-options-row__control--color">
					<label class="ht21-color-picker" title="Pick a color">
						<input
							type="color"
							class="ht21-color-picker__input"
							value={colorToHex(frontmatter.color)}
							on:input={onColorPickerInput}
							aria-label="Color picker"
						/>
						<span
							class="ht21-color-swatch"
							class:ht21-color-swatch--empty={!frontmatter.color}
							class:ht21-color-swatch--invalid={frontmatter.color && !colorValid}
							style="background-color: {colorValid ? frontmatter.color : 'transparent'}"
						></span>
					</label>
					<input
						type="text"
						class="ht21-input"
						value={frontmatter.color ?? ''}
						on:input={onColorInput}
						placeholder="(theme default)"
					/>
				</div>
			</div>
		</div>

		<div class="ht21-options-section">
			<h5 class="ht21-options-section__heading">Numeric</h5>

			<div class="ht21-options-row">
				<div class="ht21-options-row__info">
					<div class="ht21-options-row__name">Numeric habit</div>
					<div class="ht21-options-row__desc">Track a number per day instead of a simple check.</div>
				</div>
				<div class="ht21-options-row__control">
					<label class="ht21-toggle">
						<input
							type="checkbox"
							checked={isNumeric}
							on:change={onNumericToggle}
						/>
						<span class="ht21-toggle__track"></span>
					</label>
				</div>
			</div>

			{#if isNumeric}
				<div class="ht21-options-row">
					<div class="ht21-options-row__info">
						<div class="ht21-options-row__name">Metric</div>
						<div class="ht21-options-row__desc">Unit suffix shown next to the value (e.g. <code>h</code>, <code>pages</code>).</div>
					</div>
					<div class="ht21-options-row__control">
						<input
							type="text"
							class="ht21-input"
							value={frontmatter['numeric-metric'] ?? ''}
							on:input={onMetricInput}
							placeholder="(none)"
						/>
					</div>
				</div>

				<div class="ht21-options-row">
					<div class="ht21-options-row__info">
						<div class="ht21-options-row__name">Daily objective</div>
						<div class="ht21-options-row__desc">Target value per day. Empty means no objective.</div>
					</div>
					<div class="ht21-options-row__control">
						<input
							type="number"
							class="ht21-input"
							value={frontmatter[NUMERIC_DAILY] ?? ''}
							on:change={(e) => onNumberChange(NUMERIC_DAILY, e)}
							placeholder="(none)"
							min="0"
						/>
					</div>
				</div>

				<div class="ht21-options-row">
					<div class="ht21-options-row__info">
						<div class="ht21-options-row__name">Weekly objective</div>
						<div class="ht21-options-row__desc">Target value per week. Empty means no objective.</div>
					</div>
					<div class="ht21-options-row__control">
						<input
							type="number"
							class="ht21-input"
							value={frontmatter[NUMERIC_WEEKLY] ?? ''}
							on:change={(e) => onNumberChange(NUMERIC_WEEKLY, e)}
							placeholder="(none)"
							min="0"
						/>
					</div>
				</div>
			{/if}
		</div>

		<div class="ht21-options-section">
			<h5 class="ht21-options-section__heading">Streaks</h5>

			<div class="ht21-options-row">
				<div class="ht21-options-row__info">
					<div class="ht21-options-row__name">Max gap days</div>
					<div class="ht21-options-row__desc">Allowed missed days within a streak. <code>0</code> breaks the streak on any miss.</div>
				</div>
				<div class="ht21-options-row__control">
					<input
						type="number"
						class="ht21-input"
						value={frontmatter.maxGap ?? 0}
						on:input={onMaxGapInput}
						min="0"
						step="1"
					/>
				</div>
			</div>
		</div>
	</div>
{/if}
