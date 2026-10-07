/* Synthetic SDTM bootstrap fixture */
%let studyid = EXAMPLE001;
libname source "/placeholder/cdrdata/EXAMPLE001/prod/data/edc/20260131_SYNTH";
libname raw    "/placeholder/cdrdata/EXAMPLE001/prod/data/edc/20260131_SYNTH";
libname SDTM   "../../../../data/sdtm/20260131_SYNTH/primary";
libname prod "../../../../data/sdtm/20260131_SYNTH/primary";
%let __SDTMLIB = %STR(../../../../data/sdtm/20260131_SYNTH/primary);
