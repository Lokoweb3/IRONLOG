// ---------------------------------------------------------------------------
//  API CLIENT
//  Thin fetch wrapper around the backend. Replaces the old window.storage layer.
//  All requests are same-origin (dev goes through the Vite proxy), so the session
//  cookie rides along automatically; `credentials: "include"` is belt-and-braces.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, path, body, attempt = 0) {
  // Retry idempotent requests on network errors / gateway hiccups (e.g. a Fly
  // machine cold-starting). POST is excluded since it may not be idempotent.
  const retriable = method === "GET" || method === "PUT" || method === "DELETE";
  const MAX = 2;

  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "include",
      headers: body != null ? { "Content-Type": "application/json" } : undefined,
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (retriable && attempt < MAX) {
      await sleep(500 * (attempt + 1));
      return request(method, path, body, attempt + 1);
    }
    throw e;
  }

  if ((res.status === 502 || res.status === 503 || res.status === 504) && retriable && attempt < MAX) {
    await sleep(500 * (attempt + 1));
    return request(method, path, body, attempt + 1);
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  /* ----- auth ----- */

  // Returns the current user object, or null if not signed in.
  async me() {
    try {
      const data = await request("GET", "/auth/me");
      return data.user;
    } catch (e) {
      if (e.status === 401) return null;
      throw e;
    }
  },

  // Exchange a Google ID-token credential for a session; returns the user.
  async googleLogin(credential) {
    const data = await request("POST", "/auth/google", { credential });
    return data.user;
  },

  async logout() {
    await request("POST", "/auth/logout");
  },

  // Download everything the server holds for the user (for "export my data").
  async exportData() {
    return request("GET", "/auth/export");
  },

  // Permanently delete the account and all its data; clears the session.
  async deleteAccount() {
    await request("DELETE", "/auth/account");
  },

  /* ----- workouts ----- */

  // All of the user's workouts, newest first (array of session objects).
  async getWorkouts() {
    return request("GET", "/workouts");
  },

  // Persist one finished workout; returns the saved session.
  async createWorkout(session) {
    const data = await request("POST", "/workouts", session);
    return data.workout;
  },

  async deleteWorkout(id) {
    await request("DELETE", `/workouts/${encodeURIComponent(id)}`);
  },

  // Bulk restore from a backup file; returns the number newly added.
  async importWorkouts(sessions) {
    const data = await request("POST", "/workouts/import", { sessions });
    return data.added;
  },

  /* ----- program ----- */

  // The user's training program: { days, onboarded }. `onboarded` is false for a
  // brand-new account that hasn't chosen a program yet (days will be []).
  async getProgram() {
    return request("GET", "/program"); // { days, onboarded }
  },

  async saveProgram(days) {
    const data = await request("PUT", "/program", { days });
    return data.days;
  },

  // Restore the default program; returns the default days.
  async resetProgram() {
    const data = await request("POST", "/program/reset");
    return data.days;
  },

  // Clear the program so the setup wizard runs again (keeps history + profile).
  async restartOnboarding() {
    await request("DELETE", "/program");
  },

  /* ----- profile (body stats, goal, macro targets) ----- */

  async getProfile() {
    const data = await request("GET", "/profile");
    return data.profile; // null if not set up
  },
  async saveProfile(profile) {
    const data = await request("PUT", "/profile", profile);
    return data.profile;
  },

  /* ----- meals / food log ----- */

  async getMeals(date) {
    return request("GET", `/meals?date=${encodeURIComponent(date)}`);
  },
  async addMeal(entry) {
    const data = await request("POST", "/meals", entry);
    return data.meal;
  },
  async updateMeal(id, fields) {
    const data = await request("PUT", `/meals/${encodeURIComponent(id)}`, fields);
    return data.meal;
  },
  async deleteMeal(id) {
    await request("DELETE", `/meals/${encodeURIComponent(id)}`);
  },
  // add many entries (recipe log); returns the full updated day
  async bulkAddMeals(day, items) {
    return request("POST", "/meals/bulk", { day, items });
  },
  // copy a whole day's entries to another day; returns the target day's meals
  async copyDay(from, to) {
    const data = await request("POST", "/meals/copy", { from, to });
    return data.meals;
  },

  /* ----- saved meals (recipes) ----- */
  async getRecipes() {
    return request("GET", "/meals/recipes");
  },
  async addRecipe(name, items) {
    const data = await request("POST", "/meals/recipes", { name, items });
    return data.recipes;
  },
  async deleteRecipe(id) {
    await request("DELETE", `/meals/recipes/${encodeURIComponent(id)}`);
  },

  // In-app exercise form guide (instructions + demo images), or null.
  async lookupExercise(name, variation) {
    const data = await request("GET",
      `/exercises/lookup?name=${encodeURIComponent(name)}&variation=${encodeURIComponent(variation || "")}`);
    return data.match;
  },

  // Search the external food database; returns normalized results.
  async searchFoods(q) {
    const data = await request("GET", `/foods/search?q=${encodeURIComponent(q)}`);
    return data.results || [];
  },

  // Look up a single product by barcode; returns the food or null if not found.
  async getFoodByBarcode(code) {
    try {
      const data = await request("GET", `/foods/barcode/${encodeURIComponent(code)}`);
      return data.result;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },

  /* ----- recent foods + favorites ----- */

  async getRecentFoods() {
    return request("GET", "/meals/recent");
  },
  async getFavorites() {
    return request("GET", "/meals/favorites");
  },
  async addFavorite(food) {
    const data = await request("POST", "/meals/favorites", food);
    return data.favorites;
  },
  async deleteFavorite(id) {
    await request("DELETE", `/meals/favorites/${encodeURIComponent(id)}`);
  },

  /* ----- body weight ----- */

  async getWeights() {
    return request("GET", "/weights");
  },
  async logWeight(day, weightLbs) {
    const data = await request("POST", "/weights", { day, weightLbs });
    return data.weights;
  },
  async deleteWeight(id) {
    await request("DELETE", `/weights/${encodeURIComponent(id)}`);
  },

  /* ----- activity (calories burned) ----- */

  // One day's burned-calorie entry, or null if nothing logged.
  async getActivity(date) {
    const data = await request("GET", `/activity?date=${encodeURIComponent(date)}`);
    return data.activity; // { day, calories, source } | null
  },
  async logActivity(day, calories, source) {
    const data = await request("POST", "/activity", { day, calories, source });
    return data.activity;
  },
  async clearActivity(date) {
    await request("DELETE", `/activity?date=${encodeURIComponent(date)}`);
  },
};
