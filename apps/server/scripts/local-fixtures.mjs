// Synthetic local fixtures only. Never imported by account initialization or migrations.
export function demoState(seedDate, initialState) {
  const date = (offset) =>
    new Date(Date.parse(`${seedDate}T12:00:00.000Z`) + offset * 86_400_000)
      .toISOString()
      .slice(0, 10);
  const timestamp = `${seedDate}T12:00:00.000Z`;
  const state = initialState('Synthetic demo workspace');
  state.settings = {
    ...state.settings,
    training: { calories: 2400, protein: 160, carbs: 300, fat: 62 },
    rest: { calories: 2100, protein: 160, carbs: 225, fat: 62 },
    schedule: {
      0: 'rest',
      1: 'strength',
      2: 'strength',
      3: 'rest',
      4: 'strength',
      5: 'strength',
      6: 'rest',
    },
    profile: {
      ...state.settings.profile,
      goals: 'Synthetic strength and nutrition tracking demo',
      experience: 'Training regularly',
      equipment: 'Dumbbells and a bench',
    },
    setup: { completedAt: timestamp, nutritionTargetsSet: true },
  };
  state.recipes = [
    {
      id: 'local-oats',
      name: 'Berry overnight oats',
      category: 'breakfast',
      nutrition: { calories: 420, protein: 28, carbs: 56, fat: 10 },
      ingredients: [
        { name: 'Rolled oats', quantity: 60, unit: 'g', aisle: 'Pantry' },
        { name: 'Greek yogurt', quantity: 170, unit: 'g', aisle: 'Dairy' },
        { name: 'Mixed berries', quantity: 100, unit: 'g', aisle: 'Produce' },
      ],
      steps: [
        'Mix oats and yogurt with a little water.',
        'Refrigerate overnight and top with berries.',
      ],
      color: '#54735a',
    },
    {
      id: 'local-rice-bowl',
      name: 'Chicken and rice bowl',
      category: 'main',
      nutrition: { calories: 610, protein: 48, carbs: 72, fat: 14 },
      ingredients: [
        { name: 'Chicken breast', quantity: 150, unit: 'g', aisle: 'Protein' },
        { name: 'Cooked rice', quantity: 200, unit: 'g', aisle: 'Pantry' },
        { name: 'Broccoli', quantity: 120, unit: 'g', aisle: 'Produce' },
      ],
      steps: ['Cook chicken thoroughly.', 'Steam broccoli and serve with rice and chicken.'],
      color: '#b17d48',
    },
  ].map((recipe) => ({
    ...recipe,
    description: 'Synthetic local development recipe; nutrition is illustrative.',
    prepMinutes: 10,
    cookMinutes: 15,
    storage: 'Refrigerate promptly.',
    variation: '',
    tags: ['local demo'],
    source: 'manual',
    favorite: true,
    createdAt: timestamp,
  }));
  state.plan = Array.from({ length: 7 }, (_, offset) => [
    {
      id: `local-breakfast-${offset}`,
      date: date(offset),
      slot: 'breakfast',
      recipeId: 'local-oats',
      servings: 1,
    },
    {
      id: `local-lunch-${offset}`,
      date: date(offset),
      slot: 'lunch',
      recipeId: 'local-rice-bowl',
      servings: 1,
    },
  ]).flat();
  state.logs = [-2, -1, 0].map((offset) => ({
    id: `local-food-${offset + 2}`,
    date: date(offset),
    slot: 'breakfast',
    name: state.recipes[0].name,
    nutrition: { ...state.recipes[0].nutrition },
    servings: 1,
    recipeId: 'local-oats',
    ...(offset === 0 ? { planEntryId: 'local-breakfast-0' } : {}),
    createdAt: timestamp,
  }));
  const exercise = {
    id: 'local-goblet-squat',
    name: 'Goblet squat',
    loadType: 'total',
    targetSets: 3,
    repMin: 8,
    repMax: 12,
    targetRir: 2,
    restSeconds: 90,
    notes: 'Synthetic demo exercise',
    targetLoad: { weight: 35, unit: 'lb' },
  };
  state.training.templates = [
    {
      id: 'local-strength',
      name: 'Demo full-body strength',
      kind: 'strength',
      description: 'Synthetic routine for local UI development.',
      durationMinutes: 45,
      exercises: [exercise],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  state.training.sessions = [-3, 0, 2, 4].map((offset, index) => ({
    id: `local-workout-${index}`,
    templateId: 'local-strength',
    date: date(offset),
    name: 'Demo full-body strength',
    kind: 'strength',
    status: offset < 0 ? 'completed' : 'planned',
    unit: 'lb',
    exercises: [
      {
        ...exercise,
        sets: Array.from({ length: 3 }, (_, set) => ({
          id: `local-set-${index}-${set}`,
          weight: offset < 0 ? 35 : null,
          reps: offset < 0 ? 10 : null,
          rir: offset < 0 ? 2 : null,
          completed: offset < 0,
          kind: 'working',
        })),
      },
    ],
    plannedMinutes: 45,
    durationMinutes: offset < 0 ? 42 : null,
    rounds: null,
    sessionRpe: offset < 0 ? 7 : null,
    readiness: null,
    notes: 'Synthetic local development data, not actual activity.',
    changeReason: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  state.training.scheduledDates = state.training.sessions.map((session) => session.date);
  state.training.checkIns = [-14, -7, 0].map((offset, index) => ({
    id: `local-checkin-${index}`,
    date: date(offset),
    bodyWeight: 180 - index,
    waist: 33,
    sleepHours: 7.5,
    energy: 4,
    soreness: 2,
    boxingQuality: null,
    notes: 'Synthetic local development progress record.',
  }));
  return state;
}
