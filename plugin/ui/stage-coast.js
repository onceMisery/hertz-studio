// SPDX-License-Identifier: MIT
// Coast retains its local quality/parameters; StageSceneHost owns admission and frames.
(function () {
  'use strict';
  var tod = 0, interact = true, downgraded = false;
  var host = StageSceneHost({
    id: 'coast', label: '海岸舞台', engine: function () { return window.CoastStagePure; },
    requestedQuality: function () { return 'high'; },
    quality: function () { return downgraded || document.body.classList.contains('stage-lowfx') ? 'low' : 'high'; },
    options: function () { return { tod: tod, interactive: interact }; },
    apply: function () { CoastStagePure.setTimeOfDay(tod); CoastStagePure.setInteraction(interact); }
  });
  document.addEventListener('stage:fps', function (event) {
    if (!event.detail || !event.detail.lowfx || downgraded) return;
    downgraded = true; if (host.stats().mounted) host.retry();
  });
  window.StageCoast = {
    available: host.available, setHost: host.setHost, retry: host.retry, stats: host.stats,
    degradedBecause: host.degradedBecause, setRig: host.setRig,
    setPrefs: function (prefs) {
      if (!prefs) return;
      if (Number.isFinite(prefs.tod)) tod = Math.min(1, Math.max(0, prefs.tod));
      if (typeof prefs.interact === 'boolean') interact = prefs.interact;
      host.apply();
    },
    setInteraction: function (value) { interact = !!value; host.apply(); }
  };
}());
