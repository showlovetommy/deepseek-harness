; Show per-file progress: the default installer UI only paints a progress bar,
; so copying/removal looks stuck. ShowInstDetails is a compile-time attribute
; (header); SetDetailsPrint is a runtime instruction, so it goes in the
; onInit-time customInit hook instead of the header.
!macro customHeader
  ShowInstDetails show
!macroend
!macro customInit
  SetDetailsPrint both
!macroend
