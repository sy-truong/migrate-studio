/* Synthetic TLF setup fixture */
%include "&targetStudy.\Dev\Programs\TLF\autoexec.sas";
%mheadfoot;
proc report data=padam.adlb nowd;
run;
