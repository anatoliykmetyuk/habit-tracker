<script>
	import {debugLog, isValidCSSColor} from './utils'

	import {onDestroy} from 'svelte'
	import {Modal, Notice, parseYaml, Setting, TFile} from 'obsidian'
	import {getDayOfTheWeek} from './utils'
	import {differenceInCalendarDays, parseISO, format} from 'date-fns'
	import {
		normalizeEntries,
		findEntry,
		hasEntry,
		upsertEntry,
		removeEntry,
		isFiniteNumber,
	} from './entries'

	export let app
	export let name
	export let path
	export let dates
	export let debug
	export let pluginName
	export let userSettings
	export let globalSettings
	export let showWeeklySummary = false
	export let weeklySummaryDates = []

	/** @type {import('./entries').Entry[]} */
	let entries = []
	let frontmatter = {}
	let habitName = name
	let customStyles = ''
	let savingChanges = false // this helps the file change listner know if we made a change. if not, it reloads the data for the habit

	// Reactive color resolution - updates whenever frontmatter, userSettings, or globalSettings change
	$: {
		const resolvedColor =
			frontmatter.color || userSettings.color || globalSettings.defaultColor
		if (resolvedColor && isValidCSSColor(resolvedColor)) {
			customStyles = `--habit-bg-ticked: ${resolvedColor}`
		} else {
			customStyles = ''
		}
	}
	$: showStreaks =
		userSettings.showStreaks !== undefined
			? userSettings.showStreaks
			: globalSettings.showStreaks
	$: isNumeric = frontmatter.numeric === true
	$: numericMetric =
		frontmatter['numeric-metric'] === undefined ||
		frontmatter['numeric-metric'] === null
			? ''
			: String(frontmatter['numeric-metric'])
	$: numericDailyObjective = getOptionalNumber(
		frontmatter['numeric-daily-objective'],
	)
	$: numericWeeklyObjective = getOptionalNumber(
		frontmatter['numeric-weekly-objective'],
	)

	const getOptionalNumber = (value) => {
		if (value === undefined || value === null || value === '') return null
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : null
	}

	const normalizeNumber = (value) =>
		Math.round((Number(value) + Number.EPSILON) * 1e10) / 1e10

	const formatNumber = (value) => {
		if (!Number.isFinite(value)) return ''
		return Number.isInteger(value)
			? String(value)
			: String(Number(value.toFixed(10)))
	}

	const formatNumericValue = (value) =>
		`${formatNumber(value)}${numericMetric}`

	const hasNumericEntry = (date) => {
		const entry = findEntry(entries, date)
		return entry !== undefined && isFiniteNumber(entry.value)
	}

	$: renderedDates = (() => {
		// Numeric habits strictly ignore maxGap — the user wants a tight
		// pill with no gap days. Non-numeric habits honour frontmatter.maxGap.
		const maxGap = isNumeric ? 0 : Number(frontmatter.maxGap) || 0
		const gapStyle =
			userSettings.gapStyle !== undefined
				? userSettings.gapStyle
				: globalSettings.gapStyle

		// entries is guaranteed sorted by date by the entries.ts helpers
		// (both normalizeEntries on read and upsertEntry/removeEntry on
		// write), so we can iterate it chronologically without re-sorting.
		const entryDateList = entries.map((e) => e.date)
		const entryDates = new Set(entryDateList)

		// For numeric, precompute the (date -> value) lookup once.
		const numericValueByDate = new Map()
		if (isNumeric) {
			for (const e of entries) {
				if (isFiniteNumber(e.value)) {
					numericValueByDate.set(e.date, e.value)
				}
			}
		}

		// Pass 1 — mark each date with ticked, gap, hasValue, value
		const days = dates.map((date) => {
			let ticked
			let gap = false
			let hasValue = false
			let value = null

			if (isNumeric) {
				hasValue = numericValueByDate.has(date)
				value = hasValue ? numericValueByDate.get(date) : null
				ticked =
					hasValue &&
					value !== null &&
					(numericDailyObjective === null ||
						value >= numericDailyObjective)
			} else {
				ticked = entryDates.has(date)
				if (!ticked && maxGap > 0) {
					// Gap only between consecutive entries whose gap ≤ maxGap.
					// entryDateList is sorted, so consecutive array indices
					// are also consecutive in time.
					const parsed = parseISO(date)
					for (let i = 0; i < entryDateList.length - 1; i++) {
						const prev = parseISO(entryDateList[i])
						const next = parseISO(entryDateList[i + 1])
						if (
							differenceInCalendarDays(parsed, prev) > 0 &&
							differenceInCalendarDays(next, parsed) > 0
						) {
							if (differenceInCalendarDays(next, prev) - 1 <= maxGap) {
								gap = true
							}
							break
						}
					}
				}
			}

			return {
				date,
				ticked,
				gap,
				hasValue,
				value,
				deadline: false,
				streakStart: false,
				streakEnd: false,
				streakCount: 0,
				classes: '',
				display: hasValue ? formatNumericValue(value) : '',
			}
		})

		// Pass 2 — identify streak boundaries and counts
		let streakStartIdx = -1
		for (let i = 0; i <= days.length; i++) {
			const inStreak = i < days.length && (days[i].ticked || days[i].gap)
			if (inStreak && streakStartIdx === -1) {
				streakStartIdx = i
			} else if (!inStreak && streakStartIdx !== -1) {
				// Streak just ended at i-1
				const endIdx = i - 1

				// Find first and last ticked dates in this visible run
				let firstTickDate = null
				let lastTickDate = null
				for (let j = streakStartIdx; j <= endIdx; j++) {
					if (days[j].ticked) {
						if (!firstTickDate) firstTickDate = days[j].date
						lastTickDate = days[j].date
					}
				}

				// streakStart: only if the streak truly begins here
				// (no entry within maxGap before the first visible date)
				if (firstTickDate) {
					const firstTickIdx = entryDateList.indexOf(firstTickDate)
					const prevEntryDate =
						firstTickIdx > 0 ? entryDateList[firstTickIdx - 1] : null
					const continuesFromBefore =
						prevEntryDate &&
						differenceInCalendarDays(
							parseISO(firstTickDate),
							parseISO(prevEntryDate),
						) -
							1 <=
							maxGap
					if (!continuesFromBefore) {
						days[streakStartIdx].streakStart = true
					}
				} else {
					days[streakStartIdx].streakStart = true
				}

				// streakEnd: only if the streak truly ends within the visible range
				if (lastTickDate) {
					const lastTickIdx = entryDateList.indexOf(lastTickDate)
					const nextEntryDate =
						lastTickIdx < entryDateList.length - 1
							? entryDateList[lastTickIdx + 1]
							: null
					const continuesAfter =
						nextEntryDate &&
						differenceInCalendarDays(
							parseISO(nextEntryDate),
							parseISO(lastTickDate),
						) -
							1 <=
							maxGap
					if (!continuesAfter) {
						days[endIdx].streakEnd = true
					}
				} else {
					days[endIdx].streakEnd = true
				}

				// Count: walk backward through entries from the last visible
				// tick. With maxGap=0 (numeric), any gap > 0 breaks the count.
				let count = 0
				if (lastTickDate) {
					const anchorIdx = entryDateList.indexOf(lastTickDate)
					if (anchorIdx !== -1) {
						count = 1
						for (let j = anchorIdx; j > 0; j--) {
							const gapDays =
								differenceInCalendarDays(
									parseISO(entryDateList[j]),
									parseISO(entryDateList[j - 1]),
								) - 1
							if (gapDays > maxGap) break
							count++
						}
					}
				}

				days[endIdx].streakCount = count

				streakStartIdx = -1
			}
		}

		// Pass 3 — ghost dot on the last day of the gap (deadline to keep
		// streak alive). Non-numeric only — numeric has no maxGap.
		if (!isNumeric && maxGap > 0 && entryDateList.length > 0) {
			const today = format(new Date(), 'yyyy-MM-dd')
			const lastEntryDate = entryDateList[entryDateList.length - 1]
			const deadlineDate = format(
				new Date(parseISO(lastEntryDate).getTime() + (maxGap + 1) * 86400000),
				'yyyy-MM-dd',
			)
			if (deadlineDate >= today) {
				const ghostDay = days.find((d) => d.date === deadlineDate)
				if (ghostDay && !ghostDay.ticked) {
					ghostDay.deadline = true
				}
			}
		}

		// Build classes — same streak classes for both numeric and
		// non-numeric so the pill renders the same way regardless of mode.
		for (const day of days) {
			const cls = [
				'habit-tracker__cell',
				`habit-tracker__cell--${getDayOfTheWeek(day.date)}`,
				'habit-tick',
			]
			if (isNumeric) cls.push('habit-tick--numeric')
			if (day.ticked) cls.push('habit-tick--ticked')
			if (isNumeric && day.hasValue) cls.push('habit-tick--numeric-recorded')
			if (showStreaks) {
				const inStrk = day.ticked || day.gap
				if (inStrk) cls.push('habit-tick--streak')
				if (day.gap && !day.ticked) {
					cls.push('habit-tick--streak-gap')
					cls.push(gapStyle === 'faded' ? 'habit-tick--gap-faded' : 'habit-tick--gap-default')
				}
				if (day.streakStart) cls.push('habit-tick--streak-start')
				if (day.streakEnd) cls.push('habit-tick--streak-end')
				if (day.streakCount > 0 && !day.streakEnd)
					cls.push('habit-tick--streak-count')
				if (day.deadline) cls.push('habit-tick--streak-deadline')
			}
			day.classes = cls.join(' ')
		}

		return days
	})()

	$: weeklyTotal = isNumeric
		? normalizeNumber(
				weeklySummaryDates.reduce((total, date) => {
					const entry = findEntry(entries, date)
					if (entry && isFiniteNumber(entry.value)) {
						return total + entry.value
					}
					return total
				}, 0),
			)
		: 0
	$: weeklyCompleted =
		isNumeric &&
		(numericWeeklyObjective === null ||
			weeklyTotal >= numericWeeklyObjective)

	const init = async function () {
		debugLog(`Loading habit ${habitName}`, debug, undefined, pluginName)

		const getFrontmatter = async function (filePath) {
			const file = app.vault.getAbstractFileByPath(filePath)

			if (!file || !(file instanceof TFile)) {
				debugLog(
					`No file found for path: ${filePath}`,
					debug,
					undefined,
					pluginName,
				)
				return {}
			}

			try {
				return await app.vault.read(file).then((result) => {
					const frontmatter = result.split('---')[1]

					if (!frontmatter) {
						return {entries: []}
					}
					const fmParsed = parseYaml(frontmatter)
					if (fmParsed['entries'] == undefined) {
						fmParsed['entries'] = []
					}

					return fmParsed
				})
			} catch (error) {
				debugLog(
					`Error in habit ${habitName}: ${error.message}`,
					debug,
					undefined,
					pluginName,
				)
				return {}
			}
		}

		frontmatter = await getFrontmatter(path)
		debugLog(`Frontmatter for ${path} ↴`, debug)
		debugLog(frontmatter, debug)
		entries = normalizeEntries(frontmatter.entries)
		habitName = frontmatter.title || habitName

		const entryCount = entries.length
		debugLog(`Habit "${habitName}": Found ${entryCount} entries`, debug)
		debugLog(entries, debug, undefined, pluginName)
	}

	const saveNumericEntry = async (date, value) => {
		const file = app.vault.getAbstractFileByPath(path)
		if (!file || !(file instanceof TFile)) {
			new Notice(`${pluginName}: file missing while saving numeric entry`)
			return
		}

		// Only ever touches the one day the user edited. Clearing (value ===
		// null) removes the entry entirely; setting a number upserts it.
		entries =
			value === null
				? removeEntry(entries, date)
				: upsertEntry(entries, date, { value: normalizeNumber(value) })

		savingChanges = true
		await app.fileManager.processFrontMatter(file, (nextFrontmatter) => {
			nextFrontmatter.entries = entries
		})
	}

	const openNumericEntryModal = (date) => {
		const currentValue = hasNumericEntry(date)
			? findEntry(entries, date).value
			: null
		const displayDate = window.moment(date).format('ddd, ll')

		class NumericEntryModal extends Modal {
			onOpen() {
				this.titleEl.setText(`${habitName} · ${displayDate}`)
				const {contentEl} = this
				contentEl.addClass('ht21-numeric-entry-modal')
				contentEl.createDiv({
					cls: 'ht21-numeric-entry-modal__current',
					text:
						currentValue === null
							? 'No value recorded'
							: `Current: ${formatNumericValue(currentValue)}`,
				})

				let setValue = currentValue === null ? '' : String(currentValue)
				let addValue = ''

				const applySetValue = async () => {
					const parsed = Number(setValue)
					if (setValue.trim() === '' || !Number.isFinite(parsed)) {
						new Notice('Enter a valid number to set the total')
						return
					}
					await saveNumericEntry(date, parsed)
					this.close()
				}

				const applyAddValue = async () => {
					const parsed = Number(addValue)
					if (addValue.trim() === '' || !Number.isFinite(parsed)) {
						new Notice('Enter a valid number to add')
						return
					}
					await saveNumericEntry(
						date,
						normalizeNumber((currentValue ?? 0) + parsed),
					)
					this.close()
				}

				new Setting(contentEl)
					.setName('Set total')
					.setDesc('Replace the recorded value for this day.')
					.addText((text) => {
						text.setValue(setValue).setPlaceholder('0')
						text.inputEl.type = 'number'
						text.inputEl.step = 'any'
						text.inputEl.inputMode = 'decimal'
						text.onChange((value) => {
							setValue = value
						})
						text.inputEl.addEventListener('keydown', (event) => {
							if (event.key === 'Enter') applySetValue()
						})
					})
					.addButton((button) =>
						button
							.setButtonText('Set')
							.setCta()
							.onClick(applySetValue),
					)

				new Setting(contentEl)
					.setName('Add amount')
					.setDesc('Add to the existing value without replacing it.')
					.addText((text) => {
						text.setPlaceholder('0')
						text.inputEl.type = 'number'
						text.inputEl.step = 'any'
						text.inputEl.inputMode = 'decimal'
						text.onChange((value) => {
							addValue = value
						})
						text.inputEl.addEventListener('keydown', (event) => {
							if (event.key === 'Enter') applyAddValue()
						})
					})
					.addButton((button) =>
						button.setButtonText('Add').onClick(applyAddValue),
					)

				if (currentValue !== null) {
					new Setting(contentEl)
						.setName('Clear entry')
						.setDesc('Remove the recorded value for this day.')
						.addButton((button) =>
							button
								.setButtonText('Clear')
								.setWarning()
								.onClick(async () => {
									await saveNumericEntry(date, null)
									this.close()
								}),
						)
				}
			}
		}

		new NumericEntryModal(app).open()
	}

	const toggleHabit = function (date) {
		const file = app.vault.getAbstractFileByPath(path)
		if (!file || !(file instanceof TFile)) {
			new Notice(`${pluginName}: file missing while trying to toggle habit`)
			return
		}

		// Pure toggle: only ever touches the one day the user clicked.
		// If the day had a value (from a previous numeric session), it's
		// dropped — clicking in non-numeric mode is a boolean toggle.
		entries = hasEntry(entries, date)
			? removeEntry(entries, date)
			: upsertEntry(entries, date, {})

		savingChanges = true

		app.fileManager.processFrontMatter(file, (frontmatter) => {
			frontmatter['entries'] = entries
		})
	}

	init()

	let tooltipEl = null

	function showTooltip(e, day) {
		if (!day.deadline) return
		hideTooltip()
		const rect = e.currentTarget.getBoundingClientRect()

		tooltipEl = document.body.createDiv({
			cls: 'ht21-tooltip',
			text: 'Last day to keep your streak alive!',
		})
		tooltipEl.style.left = `${rect.left + rect.width / 2}px`
		tooltipEl.style.top = `${rect.top - 4}px`
	}

	function hideTooltip() {
		if (tooltipEl) {
			tooltipEl.remove()
			tooltipEl = null
		}
	}

	const modifyRef = app.vault.on('modify', (file) => {
		if (file.path === path) {
			if (!savingChanges) {
				console.log('oh shit, i was modified')
				init()
			}
			savingChanges = false
		}
	})

	onDestroy(() => {
		app.vault.offref(modifyRef)
		hideTooltip()
	})
</script>

<!-- <div bind:this={rootElement}> -->
<div
	class="habit-tracker__row"
	style={customStyles}
>
	<div class="habit-tracker__cell--name habit-tracker__cell">
		<a
			href={path}
			aria-label={path}
			class="internal-link">{habitName}</a
		>
	</div>
	{#if renderedDates.length}
		{#each renderedDates as day}
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<!-- svelte-ignore a11y-click-events-have-key-events -->
			<div
				class={day.classes}
				ticked={day.ticked}
				on:mouseenter={(e) => showTooltip(e, day)}
				on:mouseleave={hideTooltip}
				on:click={() =>
					isNumeric
						? openNumericEntryModal(day.date)
						: toggleHabit(day.date)}
			>
				<span
					class="habit-tick__inner"
					title={isNumeric && day.hasValue
						? numericDailyObjective === null
							? formatNumericValue(day.value)
							: `${formatNumericValue(day.value)} / ${formatNumericValue(
									numericDailyObjective,
								)}`
						: undefined}
				>
					{#if isNumeric}
						{day.display}
					{:else if showStreaks && day.streakEnd && day.streakCount > 1}
						{day.streakCount}
					{/if}
				</span>
			</div>
		{/each}
	{/if}
	{#if showWeeklySummary}
		<div
			class="habit-tracker__cell habit-tracker__cell--weekly-summary {isNumeric
				? 'habit-tracker__cell--numeric-summary'
				: ''} {weeklyCompleted ? 'habit-tick--ticked' : ''}"
			title={isNumeric
				? numericWeeklyObjective === null
					? `Weekly total: ${formatNumericValue(weeklyTotal)}`
					: `Weekly total: ${formatNumericValue(
							weeklyTotal,
						)} / ${formatNumericValue(numericWeeklyObjective)}`
				: undefined}
		>
			{#if isNumeric}
				<span class="habit-tick__inner">
					{formatNumericValue(weeklyTotal)}
				</span>
			{/if}
		</div>
	{/if}
</div>
