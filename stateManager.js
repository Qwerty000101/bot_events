class StateManager {
  constructor() {
    this.userStates = new Map();
  }

  getUserState(userId) {
    return this.userStates.get(userId);
  }

  setUserState(userId, state) {
    this.userStates.set(userId, state);
  }

  deleteUserState(userId) {
    return this.userStates.delete(userId);
  }

  hasUserState(userId) {
    return this.userStates.has(userId);
  }

  clear() {
    this.userStates.clear();
  }
}

module.exports = new StateManager();