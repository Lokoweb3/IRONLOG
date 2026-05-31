// The default program every new account is seeded with — the original 4-day
// split. Each day has a stable `key`, display fields, a calendar `color`, and a
// list of exercises ({ name, variations[], sets } where `sets` is the default
// set COUNT). Users can edit/delete/add freely afterward; this is just the seed.
export const DEFAULT_PROGRAM_DAYS = [
  {
    key: "lower1",
    name: "Lower Body — Day 1",
    focus: "Glutes & Quads",
    tag: "LB1",
    color: "#d8ff36",
    exercises: [
      { key: "lower1-1", name: "Standard Squats", variations: ["Barbell", "Smith Machine", "Hack Squat"], sets: 3 },
      { key: "lower1-2", name: "RDL", variations: ["Barbell", "Dumbbells", "Smith Machine"], sets: 2 },
      { key: "lower1-3", name: "Seated Leg Extension", variations: [], sets: 3 },
      { key: "lower1-4", name: "Abductor & Adductor Machine", variations: [], sets: 2 },
      { key: "lower1-5", name: "Calf Raise", variations: [], sets: 3 },
    ],
  },
  {
    key: "upper1",
    name: "Upper Body — Day 1",
    focus: "Chest Bias",
    tag: "UB1",
    color: "#46d9ff",
    exercises: [
      { key: "upper1-1", name: "Incline Press", variations: ["Dumbbell", "Smith Machine", "Incline Machine"], sets: 3 },
      { key: "upper1-2", name: "Flat Press", variations: ["Dumbbell", "Chest Press Machine"], sets: 3 },
      { key: "upper1-3", name: "Lat Pulldown — Narrow Grip", variations: [], sets: 2 },
      { key: "upper1-4", name: "Lat Pulldown — Wide Grip", variations: [], sets: 2 },
      { key: "upper1-5", name: "Close Grip Row", variations: [], sets: 2 },
      { key: "upper1-6", name: "Overhand Wide Grip Row", variations: [], sets: 2 },
      { key: "upper1-7", name: "Preacher Curls", variations: ["Dumbbells", "Machine"], sets: 2 },
      { key: "upper1-8", name: "Hammer Curls", variations: ["Dumbbells", "Machine"], sets: 2 },
      { key: "upper1-9", name: "Rear Delt Fly", variations: ["Reverse Delt Machine", "Cable Rear Delt"], sets: 2 },
    ],
  },
  {
    key: "lower2",
    name: "Lower Body — Day 2",
    focus: "Hamstring Focus",
    tag: "LB2",
    color: "#ffb13e",
    exercises: [
      { key: "lower2-1", name: "RDL", variations: ["Barbell", "Dumbbells", "Smith Machine"], sets: 3 },
      { key: "lower2-2", name: "Hip Thrust", variations: [], sets: 3 },
      { key: "lower2-3", name: "Leg Extensions", variations: [], sets: 3 },
      { key: "lower2-4", name: "Leg Curl", variations: ["Prone Leg Curl", "Lying Leg Curl"], sets: 3 },
      { key: "lower2-5", name: "Calf Raise", variations: [], sets: 3 },
    ],
  },
  {
    key: "upper2",
    name: "Upper Body — Day 2",
    focus: "Back Bias",
    tag: "UB2",
    color: "#ff6fd0",
    exercises: [
      { key: "upper2-1", name: "Lat Pulldown — Narrow Grip", variations: [], sets: 3 },
      { key: "upper2-2", name: "Lat Pulldown — Wide Grip", variations: [], sets: 3 },
      { key: "upper2-3", name: "Close Grip Row", variations: [], sets: 3 },
      { key: "upper2-4", name: "Wide Grip Row", variations: [], sets: 3 },
      { key: "upper2-5", name: "Incline Press", variations: ["Smith Machine", "Dumbbell", "Conventional Machine"], sets: 3 },
      { key: "upper2-6", name: "Flat Press", variations: ["Dumbbell", "Flat Press Machine"], sets: 3 },
      { key: "upper2-7", name: "Overhead Triceps Extension", variations: ["Cable", "Dumbbell"], sets: 2 },
      { key: "upper2-8", name: "Triceps Pushdown (Cable)", variations: [], sets: 2 },
      { key: "upper2-9", name: "Cable Cross Triceps Extension", variations: [], sets: 1 },
      { key: "upper2-10", name: "Lateral Raises", variations: ["Dumbbell", "Machine"], sets: 2 },
    ],
  },
];
