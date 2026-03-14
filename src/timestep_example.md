User presses →

PanelManager.stepForward()
  │
  ├─ dominant = 'analysis' (RAP MSLP), currentKey = '006'
  │   next key = '007'
  │
  ├─ _applyMatchedKeys('007')
  │     │
  │     ├─ 'analysis' controller.setKey('007')
  │     │   └─ MultiPlotLayer 'analysis/mslp_fill'.setActiveKey('007')   ← instant GPU swap
  │     │   └─ MultiPlotLayer 'analysis/mslp_cntr'.setActiveKey('007')   ← instant GPU swap
  │     │
  │     ├─ matchMap['007']['radar'] = '20250302_1800'   (closest MRMS valid time)
  │     │   └─ 'radar' controller.setKey('20250302_1800')
  │     │       └─ MultiPlotLayer 'radar/mrms_cref'.setActiveKey('20250302_1800')  ← GPU swap
  │     │
  │     └─ matchMap['007']['obs'] = '20250302_1800'     (closest METAR valid time)
  │         └─ 'obs' controller.setKey('20250302_1800')
  │             └─ MultiPlotLayer 'obs/sfc_obs_standard'.setActiveKey('20250302_1800') ← GPU swap
  │
  └─ onTimeChange('007', '2025-03-02 07:00 UTC', { analysis: '007', radar: '20250302_1800', obs: '20250302_1800' })
       └─ UI updates time label + slot panel + fhr slider
