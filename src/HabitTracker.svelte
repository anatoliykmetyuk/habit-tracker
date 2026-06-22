<script lang="ts">
	import {debugLog, pluralize, renderPrettyDate} from './utils'
	import {
		createDailyNote,
		getDailyNote,
		getAllDailyNotes,
		appHasDailyNotesPluginLoaded,
	} from 'obsidian-daily-notes-interface'
	import {onMount, onDestroy} from 'svelte'

	import Habit from './Habit.svelte'

	import {TFile, TFolder, Notice, type Plugin} from 'obsidian'
	import {getDateAsString, getDayOfTheWeek} from './utils.js'
	import {
		addDays,
		eachDayOfInterval,
		endOfWeek,
		getDate,
		isToday,
		parseISO,
		startOfWeek,
		subDays,
	} from 'date-fns'

	// TypeScript interfaces for better state management
	interface HabitTrackerSettings {
		path: string
		firstDisplayedDate: string
		lastDisplayedDate: string
		daysToShow: number
		weeklyView: boolean
		weeksAhead: number
		weeksBehind: number
		cellWidth: number
		cellHeight: number
		showDateTooltips: boolean
		debug: boolean
		matchLineLength: boolean
	}

	interface HabitData {
		file: TFile
		basename: string
		path: string
		numeric: boolean
	}

	interface ComputedState {
		dates: string[]
		habits: HabitData[]
	}

	interface UIState {
		fatalError: string
		rootElement: HTMLElement | null
		habitSource: TFile | TFolder | null
	}

	interface HabitTrackerState {
		settings: HabitTrackerSettings
		computed: ComputedState
		ui: UIState
	}

	export let app: Plugin['app']
	export let pluginName: string
	export let globalSettings: {
		path: string
		firstDisplayedDate: string
		daysToShow: number
		weeklyView: boolean
		weeksAhead: number
		weeksBehind: number
		cellWidth: number
		cellHeight: number
		showDateTooltips: boolean
		debug: boolean
		matchLineLength: boolean
		defaultColor: string
		showStreaks: boolean	
		openDailyNoteOnClick: boolean
		gapStyle: string
	}
	export let userSettings: Partial<{
		path: string
		firstDisplayedDate: string
		lastDisplayedDate: string
		daysToShow: number
		weeklyView: boolean
		weeksAhead: number
		weeksBehind: number
		cellWidth: number
		cellHeight: number
		showDateTooltips: boolean
		debug: boolean
		matchLineLength: boolean
		color: string
		showStreaks: boolean
		gapStyle: string
	}>

	// Default settings - use global settings as defaults
	const createDefaultSettings = (): HabitTrackerSettings => {
		const today = new Date()
		const weeklyView = globalSettings.weeklyView
		const weeksAhead = Math.max(1, globalSettings.weeksAhead ?? 1)
		const weeksBehind = Math.max(0, globalSettings.weeksBehind ?? 0)
		const lastDisplayedDate = weeklyView
			? getDateAsString(
					addDays(
						endOfWeek(today, {weekStartsOn: 1}),
						(weeksAhead - 1) * 7,
					),
				)
			: getDateAsString(today)

		return {
			path: globalSettings.path,
			firstDisplayedDate: weeklyView
				? getDateAsString(
						addDays(
							startOfWeek(today, {weekStartsOn: 1}),
							-weeksBehind * 7,
						),
					)
				: globalSettings.firstDisplayedDate ||
					getDateAsString(subDays(today, globalSettings.daysToShow - 1)),
			lastDisplayedDate,
			daysToShow: weeklyView
				? (weeksAhead + weeksBehind) * 7
				: globalSettings.daysToShow,
			weeklyView,
			weeksAhead,
			weeksBehind,
			cellWidth: Math.max(25, globalSettings.cellWidth ?? 25),
			cellHeight: Math.max(32, globalSettings.cellHeight ?? 32),
			showDateTooltips: globalSettings.showDateTooltips ?? true,
			debug: globalSettings.debug,
			matchLineLength: globalSettings.matchLineLength,
		}
	}

	const updateDates = () => {
		state.computed.dates = eachDayOfInterval({
			start: parseISO(state.settings.firstDisplayedDate),
			end: parseISO(state.settings.lastDisplayedDate),
		}).map((date) => getDateAsString(date))
	}

	const toHabitData = (file: TFile): HabitData => ({
		file,
		basename: file.basename,
		path: file.path,
		numeric:
			app.metadataCache.getFileCache(file)?.frontmatter?.numeric === true,
	})

	// Initialize unified state
	let state: HabitTrackerState = {
		settings: createDefaultSettings(),
		computed: {
			dates: [],
			habits: [],
		},
		ui: {
			fatalError: '',
			rootElement: null,
			habitSource: null,
		},
	}

	const init = async function (userSettings: Partial<HabitTrackerSettings>) {
		// Clean up path (remove trailing slash)
		if (userSettings.path) {
			userSettings.path = userSettings.path.replace(/\/$/, '')
		}

		// Smart date/daysToShow logic: explicit user settings take priority
		const hasExplicitFirstDate = userSettings.firstDisplayedDate !== undefined
		const hasExplicitLastDate = userSettings.lastDisplayedDate !== undefined
		const hasExplicitDaysToShow = userSettings.daysToShow !== undefined
		const weeklyView =
			userSettings.weeklyView !== undefined
				? userSettings.weeklyView
				: state.settings.weeklyView
		const weeksAhead = Math.max(
			1,
			userSettings.weeksAhead ?? globalSettings.weeksAhead ?? 1,
		)
		const weeksBehind = Math.max(
			0,
			userSettings.weeksBehind ?? globalSettings.weeksBehind ?? 0,
		)
		const defaultLastDisplayedDate = weeklyView
			? state.settings.lastDisplayedDate
			: getDateAsString(new Date())

		// Start with defaults
		let resolvedSettings = {
			path: userSettings.path || state.settings.path,
			firstDisplayedDate: '',
			lastDisplayedDate:
				userSettings.lastDisplayedDate || defaultLastDisplayedDate,
			daysToShow:
				userSettings.daysToShow !== undefined
					? userSettings.daysToShow
					: weeklyView
						? 7
						: globalSettings.daysToShow,
			weeklyView,
			weeksAhead,
			weeksBehind,
			cellWidth: Math.max(
				25,
				userSettings.cellWidth ?? globalSettings.cellWidth ?? 25,
			),
			cellHeight: Math.max(
				32,
				userSettings.cellHeight ?? globalSettings.cellHeight ?? 32,
			),
			showDateTooltips:
				userSettings.showDateTooltips ??
				globalSettings.showDateTooltips ??
				true,
			matchLineLength:
				userSettings.matchLineLength !== undefined
					? userSettings.matchLineLength
					: state.settings.matchLineLength,
			debug:
				userSettings.debug !== undefined
					? userSettings.debug
					: state.settings.debug,
		}

		// Weekly view is always a complete Monday-to-Sunday week.
		if (weeklyView) {
			const today = new Date()
			resolvedSettings.firstDisplayedDate = getDateAsString(
				addDays(
					startOfWeek(today, {weekStartsOn: 1}),
					-weeksBehind * 7,
				),
			)
			resolvedSettings.lastDisplayedDate = getDateAsString(
				addDays(
					endOfWeek(today, {weekStartsOn: 1}),
					(weeksAhead - 1) * 7,
				),
			)
			resolvedSettings.daysToShow = (weeksAhead + weeksBehind) * 7
		} else if (hasExplicitFirstDate) {
			// User provided firstDisplayedDate - use it directly
			resolvedSettings.firstDisplayedDate = userSettings.firstDisplayedDate!
			// If user also provided lastDisplayedDate, recalculate daysToShow to match the actual range
			if (hasExplicitLastDate) {
				const startDate = parseISO(userSettings.firstDisplayedDate!)
				const endDate = parseISO(userSettings.lastDisplayedDate!)
				resolvedSettings.daysToShow = eachDayOfInterval({
					start: startDate,
					end: endDate,
				}).length
			}
		} else if (hasExplicitDaysToShow || hasExplicitLastDate) {
			// User provided daysToShow and/or lastDisplayedDate but not firstDisplayedDate - calculate firstDisplayedDate from lastDisplayedDate
			resolvedSettings.firstDisplayedDate = getDateAsString(
				subDays(
					parseISO(resolvedSettings.lastDisplayedDate),
					resolvedSettings.daysToShow - 1,
				),
			)
		} else {
			// No explicit user settings - use defaults
			resolvedSettings.firstDisplayedDate =
				globalSettings.firstDisplayedDate ||
				getDateAsString(
					subDays(
						parseISO(resolvedSettings.lastDisplayedDate),
						resolvedSettings.daysToShow - 1,
					),
				)
		}

		state.settings = resolvedSettings

		// Only validate essential business logic
		try {
			await validateEssentials(state.settings)
		} catch (error) {
			state.ui.fatalError = `Could not start: ${error.message}`
			console.error(`[${pluginName}] ${state.ui.fatalError}`)
			return
		}
		debugLog(state.settings, state.settings.debug)

		updateDates()

		debugLog(`Will show habits for the following dates:`, state.settings.debug)
		debugLog(state.computed.dates, state.settings.debug)

		// Load habits
		state.computed.habits = getHabits(state.settings.path)
		if (state.computed.habits && state.computed.habits.length) {
			const count = state.computed.habits.length
			debugLog(
				`Found ${count} ${pluralize(count, 'habit')} at "${state.settings.path}" ↴`,
				state.settings.debug,
				undefined,
				pluginName,
			)
			debugLog(
				state.computed.habits.map((habit) => habit.path),
				state.settings.debug,
				undefined,
				pluginName,
			)
		} else {
			// TODO add a button so they can create a habit
			state.ui.fatalError = `No habits found at "${state.settings.path}"`
			debugLog(
				`No habits found at ${state.settings.path}`,
				state.settings.debug,
				undefined,
				pluginName,
			)
			return
		}

		debugLog(`Initialization completed successfully`, state.settings.debug)
	}

	const navigate = (direction: -1 | 1) => {
		const increment = state.settings.weeklyView ? 7 : 1
		state.settings.firstDisplayedDate = getDateAsString(
			addDays(parseISO(state.settings.firstDisplayedDate), direction * increment),
		)
		state.settings.lastDisplayedDate = getDateAsString(
			addDays(parseISO(state.settings.lastDisplayedDate), direction * increment),
		)
		updateDates()
		state = {...state}
	}

	const scrollToEnd = function () {
		if (!state.ui.rootElement) {
			debugLog(
				`scrollToEnd: rootElement is null, cannot scroll`,
				state.settings.debug,
				undefined,
				pluginName,
			)
			return
		}

		const parent = state.ui.rootElement.parentElement
		if (!parent) {
			debugLog(
				`scrollToEnd: parentElement is null, cannot scroll`,
				state.settings.debug,
				undefined,
				pluginName,
			)
			return
		}

		parent.scrollLeft = 99999999
		debugLog(`scrollToEnd completed`, state.settings.debug)
	}

	const validateEssentials = async function (
		settings: Partial<HabitTrackerSettings>,
	) {
		// Only validate critical business logic that TypeScript can't catch
		if (!settings.path) {
			throw new Error('path is required - where should I load habits from?')
		}

		// Check if the path exists in the vault (Obsidian-specific validation)
		const source = app.vault.getAbstractFileByPath(settings.path)
		if (!source) {
			// Try with .md extension as fallback
			const mdSource = app.vault.getAbstractFileByPath(`${settings.path}.md`)
			if (!mdSource) {
				throw new Error(`"${settings.path}" doesn't exist in your vault`)
			}
		}

		debugLog(`Final settings are valid ↴`, state.settings.debug)
		return true
	}

	const openDailyNote = async function (date: string) {
		const moment = (window as any).moment(date)
		const allNotes = getAllDailyNotes()
		const existingNote = getDailyNote(moment, allNotes)
		const note = existingNote ?? (await createDailyNote(moment))
		await app.workspace.getLeaf(false).openFile(note)
	}

	const getHabits = function (path: string): HabitData[] {
		debugLog(`Loading habits`, state.settings.debug)
		state.ui.habitSource = app.vault.getAbstractFileByPath(path)

		if (state.ui.habitSource && state.ui.habitSource instanceof TFolder) {
			// Filter to only include files, not subfolders
			const allItems = state.ui.habitSource.children
			const filesOnly = allItems.filter((item) => item instanceof TFile)
			const count = filesOnly.length
			debugLog(
				`"${path}" points to a folder with ${count} ${pluralize(count, 'file')} inside (ignoring subfolders)`,
				state.settings.debug,
				undefined,
				pluginName,
			)
			// Sort files alphabetically by name
			const sortedFiles = filesOnly.sort((a, b) =>
				a.basename.localeCompare(b.basename),
			)
			return sortedFiles.map((file) => toHabitData(file as TFile))
		}

		if (state.ui.habitSource && state.ui.habitSource instanceof TFile) {
			debugLog(`${path} points to a file`, state.settings.debug)
			return [toHabitData(state.ui.habitSource)]
		}

		state.ui.habitSource = app.vault.getAbstractFileByPath(`${path}.md`)
		if (state.ui.habitSource) {
			debugLog(
				`Adjusted ${path} to ${path}.md and found a file`,
				state.settings.debug,
				undefined,
				pluginName,
			)
			return [toHabitData(state.ui.habitSource as TFile)]
		}

		debugLog(`${path} is not found`, state.settings.debug)
		return []
	}

	$: if (state.ui.rootElement) {
		setTimeout(() => {
			scrollToEnd()
		}, 50)
	}

	// Listen for settings refresh events
	let refreshEventListener: (event: CustomEvent) => void
	let vaultCreateRef: any
	let vaultDeleteRef: any
	let vaultRenameRef: any
	let midnightTimer: ReturnType<typeof setTimeout>

	const isInWatchedPath = (filePath: string) =>
		filePath === state.settings.path ||
		filePath.startsWith(state.settings.path + '/')

	onMount(() => {
		debugLog('Component mounted, setting up refresh listener')
		refreshEventListener = (event: CustomEvent) => {
			console.log(
				'[HabitTracker] Refresh event received:',
				event.detail.settings,
			)
			// Update global settings and reset state to use new defaults
			globalSettings = event.detail.settings

			// Reset state with new global settings as defaults
			state.settings = createDefaultSettings()
			console.log(
				'[HabitTracker] Reset state with new defaults:',
				state.settings,
			)

			console.log('[HabitTracker] Calling init with updated settings')
			init(userSettings)
		}

		// Listen for refresh events at the document level
		document.addEventListener('habit-tracker-refresh', refreshEventListener)
		debugLog('Refresh event listener added to document')

		// Schedule reload at midnight so dates stay current
		const scheduleMidnightReload = () => {
			const now = new Date()
			const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
			const msUntilMidnight = midnight.getTime() - now.getTime()
			midnightTimer = setTimeout(() => {
				debugLog('Midnight reload triggered', state.settings.debug)
				state.settings = createDefaultSettings()
				init(userSettings)
				scheduleMidnightReload()
			}, msUntilMidnight)
		}
		scheduleMidnightReload()

		// Listen for vault file changes that affect the habit list
		vaultCreateRef = app.vault.on('create', (file) => {
			if (isInWatchedPath(file.path)) init(userSettings)
		})
		vaultDeleteRef = app.vault.on('delete', (file) => {
			if (isInWatchedPath(file.path)) init(userSettings)
		})
		vaultRenameRef = app.vault.on('rename', (file, oldPath) => {
			if (isInWatchedPath(file.path) || isInWatchedPath(oldPath))
				init(userSettings)
		})
	})

	onDestroy(() => {
		if (refreshEventListener) {
			document.removeEventListener(
				'habit-tracker-refresh',
				refreshEventListener,
			)
		}
		if (vaultCreateRef) app.vault.offref(vaultCreateRef)
		if (vaultDeleteRef) app.vault.offref(vaultDeleteRef)
		if (vaultRenameRef) app.vault.offref(vaultRenameRef)
		if (midnightTimer) clearTimeout(midnightTimer)
	})

	init(userSettings)

	$: hasNumericHabits = state.computed.habits.some((habit) => habit.numeric)
	$: weeklySummaryDates = (() => {
		if (!state.settings.firstDisplayedDate || !state.settings.lastDisplayedDate) {
			return []
		}

		const anchorDate = state.settings.weeklyView
			? addDays(
					parseISO(state.settings.firstDisplayedDate),
					state.settings.weeksBehind * 7,
				)
			: parseISO(state.settings.lastDisplayedDate)
		const weekStart = startOfWeek(anchorDate, {weekStartsOn: 1})
		const weekEnd = endOfWeek(anchorDate, {weekStartsOn: 1})

		return eachDayOfInterval({start: weekStart, end: weekEnd}).map((date) =>
			getDateAsString(date),
		)
	})()
</script>

<!-- <svelte:window bind:innerWidth /> -->
{#if state.ui.fatalError}
	<div>
		<strong>🛑 {pluginName}</strong>
	</div>
	{state.ui.fatalError}
{:else if !state.computed.habits.length}
	<div>
		<strong>😕 {pluginName}</strong>
	</div>
	No habits to show at "{state.settings.path}"
{:else}
	<div
		class="habit-tracker {state.settings.matchLineLength
			? 'habit-tracker--match-line-length'
			: ''} {hasNumericHabits ? 'habit-tracker--with-summary' : ''}"
		style="--date-columns: {state.computed.dates.length}; --habit-cell-width: {state
			.settings.cellWidth}px; --habit-cell-height: {state.settings.cellHeight}px"
		bind:this={state.ui.rootElement}
	>
		<div class="habit-tracker__header habit-tracker__row">
			<div class="habit-tracker__cell--name habit-tracker__cell"></div>
			{#each state.computed.dates as date}
				<!-- svelte-ignore a11y-click-events-have-key-events -->
				<!-- svelte-ignore a11y-no-static-element-interactions -->
				<div
					class="habit-tracker__cell habit-tracker__cell--{getDayOfTheWeek(
						date,
					)}{isToday(date) ? ' habit-tracker__cell--today' : ''}"
					data-ht21-date={date}
					data-ht21-pretty-date={state.settings.showDateTooltips
						? renderPrettyDate(date)
						: undefined}
					on:click={() => openDailyNote(date)}
				>
					{getDate(parseISO(date))}
				</div>
			{/each}
			{#if hasNumericHabits}
				<div
					class="habit-tracker__cell habit-tracker__cell--weekly-summary"
					title="Weekly total"
				>
					W
				</div>
			{/if}
		</div>
		{#each state.computed.habits as habit}
			<Habit
				name={habit.basename}
				path={habit.path}
				dates={state.computed.dates}
				debug={state.settings.debug}
				{app}
				{pluginName}
				{userSettings}
				{globalSettings}
				showWeeklySummary={hasNumericHabits}
				{weeklySummaryDates}
			></Habit>
		{/each}
	</div>
	<div class="habit-tracker-navigation">
		<button
			type="button"
			class="clickable-icon habit-tracker-navigation__button"
			aria-label={state.settings.weeklyView ? 'Previous week' : 'Previous day'}
			title={state.settings.weeklyView ? 'Previous week' : 'Previous day'}
			on:click={() => navigate(-1)}
		>
			<span aria-hidden="true">&larr;</span>
		</button>
		<button
			type="button"
			class="clickable-icon habit-tracker-navigation__button"
			aria-label={state.settings.weeklyView ? 'Next week' : 'Next day'}
			title={state.settings.weeklyView ? 'Next week' : 'Next day'}
			on:click={() => navigate(1)}
		>
			<span aria-hidden="true">&rarr;</span>
		</button>
	</div>
{/if}
