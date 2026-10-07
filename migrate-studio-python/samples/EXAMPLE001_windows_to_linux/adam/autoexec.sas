/* Synthetic fixture: EXAMPLE001 Windows to Linux */
%let studyid = EXAMPLE001;
%let cutdate = %str(2026-01-31);
libname padam "../../../../data/adam/20260131_SYNTH/primary" inencoding=any;
libname raw "/placeholder/cdrdata/EXAMPLE001/prod/data/edc/20260131_SYNTH" inencoding=any;
